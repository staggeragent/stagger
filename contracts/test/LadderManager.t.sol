// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {LadderManager, IERC20} from "../src/LadderManager.sol";

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

/// Fork test against Robinhood Chain mainnet (4663).
/// forge test --fork-url https://robinhood-rpc.publicnode.com
contract LadderManagerForkTest is Test {
    address constant NPM = 0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3;
    address constant ROUTER = 0xCaf681a66D020601342297493863E78C959E5cb2;
    address constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address constant POOL = 0x52e65B17fB6E5BA00Ed806f37Afcd2DaA50271Ca; // WETH/USDG 0.01%
    uint24 constant FEE = 100;

    LadderManager lm;
    address user = makeAddr("user");
    address stranger = makeAddr("stranger");
    address treasury = makeAddr("treasury");
    address trader = makeAddr("trader");

    function setUp() public {
        if (block.chainid != 4663) {
            vm.skip(true);
            return;
        }
        lm = new LadderManager(NPM, treasury, 500); // 5%
        vm.deal(user, 10 ether);
        deal(USDG, user, 20_000e6);
        vm.deal(trader, 1_000 ether);
        deal(USDG, trader, 2_000_000e6);
    }

    function _tick() internal view returns (int24 t) {
        (, t,,,,,) = IPool(POOL).slot0();
    }

    /// below price: USDG only · around price: both · above price: WETH only
    function _bins() internal view returns (LadderManager.Bin[] memory b) {
        int24 t = _tick();
        b = new LadderManager.Bin[](3);
        b[0] = LadderManager.Bin(t - 60, t - 20, 0, 1_000e6);
        b[1] = LadderManager.Bin(t - 20, t + 20, 0.5 ether, 1_000e6);
        b[2] = LadderManager.Bin(t + 20, t + 60, 0.5 ether, 0);
    }

    function _open() internal returns (uint256 id) {
        vm.startPrank(user);
        IERC20(USDG).approve(address(lm), type(uint256).max);
        id = lm.open{value: 1 ether}(WETH, USDG, FEE, _bins(), 10_000, block.timestamp + 60);
        vm.stopPrank();
    }

    function _churn() internal {
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
    }

    function test_openMintsBinsAndRefunds() public {
        uint256 ethBefore = user.balance;
        uint256 usdgBefore = IERC20(USDG).balanceOf(user);
        uint256 id = _open();
        (address owner, address t0, address t1,, uint256[] memory ids) = lm.getLadder(id);
        assertEq(owner, user);
        assertEq(t0, WETH);
        assertEq(t1, USDG);
        assertEq(ids.length, 3);
        assertEq(lm.laddersOf(user)[0], id);
        // spent no more than offered, and the contract keeps nothing loose
        assertLe(ethBefore - user.balance, 1 ether);
        assertLe(usdgBefore - IERC20(USDG).balanceOf(user), 2_000e6);
        assertEq(IERC20(WETH).balanceOf(address(lm)), 0);
        assertEq(IERC20(USDG).balanceOf(address(lm)), 0);
        assertEq(address(lm).balance, 0);
    }

    function test_claimTakesFixedCutOfFeesOnly() public {
        uint256 id = _open();
        _churn();
        uint256 e0 = user.balance;
        uint256 u0 = IERC20(USDG).balanceOf(user);
        vm.prank(user);
        (uint256 out0, uint256 out1) = lm.claim(id, user, false);
        assertGt(out0 + out1, 0, "no fees earned");
        assertEq(user.balance - e0, out0);
        assertEq(IERC20(USDG).balanceOf(user) - u0, out1);
        // treasury got ~5/95 of what the user got
        assertApproxEqAbs(treasury.balance, out0 * 500 / 9_500, 1);
        // no cut on fees paid in non-ETH tokens
        assertEq(IERC20(USDG).balanceOf(treasury), 0);
        // second claim right away pays nothing
        vm.prank(user);
        (out0, out1) = lm.claim(id, user, false);
        assertEq(out0 + out1, 0);
    }

    function test_withdrawSomeBinsThenClose() public {
        uint256 id = _open();
        _churn();
        uint256[] memory idx = new uint256[](1);
        idx[0] = 2;
        vm.prank(user);
        lm.withdraw(id, idx, user, false, 0, 0, block.timestamp + 60);
        (,,,, uint256[] memory ids) = lm.getLadder(id);
        assertEq(ids.length, 2);

        uint256 e0 = user.balance;
        uint256 u0 = IERC20(USDG).balanceOf(user);
        vm.prank(user);
        lm.close(id, user, false, 0, 0, block.timestamp + 60);
        (,,,, ids) = lm.getLadder(id);
        assertEq(ids.length, 0);
        assertGt(user.balance + IERC20(USDG).balanceOf(user), e0 + u0);
        assertEq(IERC20(WETH).balanceOf(address(lm)), 0);
        assertEq(IERC20(USDG).balanceOf(address(lm)), 0);
    }

    function test_principalNeverCut() public {
        // open and close immediately: no fees, so the treasury must get nothing
        uint256 id = _open();
        vm.prank(user);
        lm.close(id, user, false, 0, 0, block.timestamp + 60);
        assertEq(treasury.balance, 0);
        assertEq(IERC20(USDG).balanceOf(treasury), 0);
    }

    function test_onlyOwner() public {
        uint256 id = _open();
        vm.startPrank(stranger);
        vm.expectRevert(LadderManager.NotOwner.selector);
        lm.claim(id, stranger, false);
        vm.expectRevert(LadderManager.NotOwner.selector);
        lm.close(id, stranger, false, 0, 0, block.timestamp + 60);
        vm.stopPrank();
    }

    function test_rejectsBadInput() public {
        LadderManager.Bin[] memory b = _bins();
        vm.startPrank(user);
        IERC20(USDG).approve(address(lm), type(uint256).max);
        // wrong ETH amount
        vm.expectRevert(LadderManager.EthMismatch.selector);
        lm.open{value: 0.5 ether}(WETH, USDG, FEE, b, 10_000, block.timestamp + 60);
        // tokens out of order
        vm.expectRevert(LadderManager.BadParams.selector);
        lm.open{value: 1 ether}(USDG, WETH, FEE, b, 10_000, block.timestamp + 60);
        // expired
        vm.expectRevert(LadderManager.Expired.selector);
        lm.open{value: 1 ether}(WETH, USDG, FEE, b, 10_000, block.timestamp - 1);
        // too many bins
        LadderManager.Bin[] memory many = new LadderManager.Bin[](41);
        vm.expectRevert(LadderManager.BadParams.selector);
        lm.open(WETH, USDG, FEE, many, 10_000, block.timestamp + 60);
        vm.stopPrank();
    }

    function test_feeCapAtDeploy() public {
        vm.expectRevert(LadderManager.BadParams.selector);
        new LadderManager(NPM, treasury, 1_001);
    }

    function test_closeToOtherAddressAsWeth() public {
        uint256 id = _open();
        address vault = address(new NoEthReceiver());
        vm.prank(user);
        lm.close(id, vault, true, 0, 0, block.timestamp + 60);
        assertGt(IERC20(WETH).balanceOf(vault) + IERC20(USDG).balanceOf(vault), 0);
        assertEq(IERC20(WETH).balanceOf(address(lm)), 0);
    }

    function test_closeRevertsOnSlippage() public {
        uint256 id = _open();
        vm.prank(user);
        vm.expectRevert(LadderManager.Slippage.selector);
        lm.close(id, user, false, 100 ether, 0, block.timestamp + 60);
    }

    function test_cutNeverBlocksOwner() public {
        // fee recipient that rejects ETH: owner still claims, and gets the whole fee
        LadderManager lm2 = new LadderManager(NPM, address(new NoEthReceiver()), 500);
        lm = lm2;
        uint256 id = _open();
        _churn();
        vm.prank(user);
        (uint256 out0,) = lm.claim(id, user, false);
        assertGt(out0, 0);
        assertEq(IERC20(WETH).balanceOf(address(lm)), 0);
        assertEq(address(lm).balance, 0);
    }
}

contract NoEthReceiver {}
