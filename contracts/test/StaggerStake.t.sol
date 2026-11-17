// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {LadderManager, IERC20} from "../src/LadderManager.sol";
import {StaggerStake} from "../src/StaggerStake.sol";

contract MockToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 a) external {
        balanceOf[to] += a;
    }

    function approve(address s, uint256 a) external returns (bool) {
        allowance[msg.sender][s] = a;
        return true;
    }

    function transfer(address to, uint256 a) external returns (bool) {
        balanceOf[msg.sender] -= a;
        balanceOf[to] += a;
        return true;
    }

    function transferFrom(address f, address to, uint256 a) external returns (bool) {
        allowance[f][msg.sender] -= a;
        balanceOf[f] -= a;
        balanceOf[to] += a;
        return true;
    }
}

interface ISwapRouter02 {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata) external payable returns (uint256);
}

interface IPool {
    function slot0() external view returns (uint160, int24, uint16, uint16, uint16, uint8, bool);
}

contract StaggerStakeForkTest is Test {
    address constant NPM = 0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3;
    address constant ROUTER = 0xCaf681a66D020601342297493863E78C959E5cb2;
    address constant FACTORY = 0x1f7d7550B1b028f7571E69A784071F0205FD2EfA;
    address constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address constant POOL = 0x52e65B17fB6E5BA00Ed806f37Afcd2DaA50271Ca;
    uint24 constant FEE = 100;

    StaggerStake st;
    LadderManager lm;
    MockToken rungs;
    address lp = makeAddr("lp");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address trader = makeAddr("trader");

    function setUp() public {
        if (block.chainid != 4663) {
            vm.skip(true);
            return;
        }
        st = new StaggerStake(WETH);
        lm = new LadderManager(NPM, address(st), 500);
        rungs = new MockToken();
        vm.deal(lp, 10 ether);
        deal(USDG, lp, 20_000e6);
        vm.deal(trader, 1_000 ether);
        deal(USDG, trader, 2_000_000e6);
        rungs.mint(alice, 300e18);
        rungs.mint(bob, 100e18);
    }

    function _ladderEarnsFees() internal {
        (, int24 t,,,,,) = IPool(POOL).slot0();
        LadderManager.Bin[] memory b = new LadderManager.Bin[](1);
        b[0] = LadderManager.Bin(t - 30, t + 30, 1 ether, 2_000e6);
        vm.startPrank(lp);
        IERC20(USDG).approve(address(lm), type(uint256).max);
        uint256 id = lm.open{value: 1 ether}(WETH, USDG, FEE, b, 10_000, block.timestamp + 60);
        vm.stopPrank();

        vm.startPrank(trader);
        IERC20(USDG).approve(ROUTER, type(uint256).max);
        for (uint256 i; i < 5; ++i) {
            ISwapRouter02(ROUTER).exactInputSingle{value: 20 ether}(
                ISwapRouter02.ExactInputSingleParams(WETH, USDG, FEE, trader, 20 ether, 0, 0)
            );
            ISwapRouter02(ROUTER).exactInputSingle(
                ISwapRouter02.ExactInputSingleParams(USDG, WETH, FEE, trader, 36_000e6, 0, 0)
            );
        }
        vm.stopPrank();
        vm.prank(lp);
        lm.claim(id, lp, false);
    }

    function _stake(address who, uint256 amt) internal {
        vm.startPrank(who);
        rungs.approve(address(st), amt);
        st.stake(amt);
        vm.stopPrank();
    }

    function test_setTokenOnceByDeployerOnly() public {
        vm.prank(alice);
        vm.expectRevert(StaggerStake.BadParams.selector);
        st.setToken(address(rungs));
        st.setToken(address(rungs));
        vm.expectRevert(StaggerStake.BadParams.selector);
        st.setToken(address(1));
    }

    function test_stakeBeforeTokenReverts() public {
        vm.prank(alice);
        vm.expectRevert(StaggerStake.NotReady.selector);
        st.stake(1);
    }

    function test_fullFlowFeesToStakers() public {
        st.setToken(address(rungs));
        _stake(alice, 300e18);
        _stake(bob, 100e18);

        _ladderEarnsFees();
        uint256 cut = address(st).balance;
        assertGt(cut, 0, "no ETH cut");
        assertEq(IERC20(USDG).balanceOf(address(st)), 0, "non-ETH fees must not be cut");
        vm.deal(address(st), cut + 1 ether); // fees accumulated over time (above MIN_NOTIFY)
        uint256 total = address(st).balance;

        st.notify();
        assertEq(st.committed(), total);

        vm.warp(block.timestamp + 7 days + 1);
        vm.prank(alice);
        uint256 a = st.claim();
        vm.prank(bob);
        uint256 b = st.claim();
        assertApproxEqRel(a, total * 3 / 4, 1e15);
        assertApproxEqRel(b, total / 4, 1e15);
        assertLe(a + b, total);
        assertEq(alice.balance, a);
    }

    function test_dustDoesNotResetStream() public {
        st.setToken(address(rungs));
        _stake(alice, 10e18);
        vm.deal(address(st), 1 ether);
        st.notify();
        uint256 finish = st.periodFinish();
        vm.warp(block.timestamp + 1 days);
        vm.deal(address(st), address(st).balance + 1e13); // below MIN_NOTIFY
        st.notify();
        assertEq(st.periodFinish(), finish);
    }

    function test_noStakersMeansRewardsCarryOver() public {
        st.setToken(address(rungs));
        vm.deal(address(st), 1 ether);
        st.notify();
        vm.warp(block.timestamp + 3 days);
        _stake(alice, 10e18); // releases the 3 days nobody earned
        st.notify(); // re-streams them
        vm.warp(block.timestamp + 7 days + 1);
        vm.prank(alice);
        uint256 got = st.claim();
        assertApproxEqRel(got, 1 ether, 1e12);
    }

    function test_unstakeReturnsTokens() public {
        st.setToken(address(rungs));
        _stake(alice, 50e18);
        vm.prank(alice);
        st.unstake(50e18);
        assertEq(rungs.balanceOf(alice), 300e18);
        assertEq(st.totalStaked(), 0);
    }
}
