// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.24;

import {Test, console} from "forge-std/Test.sol";
import {LadderManager, IERC20, INonfungiblePositionManager} from "../src/LadderManager.sol";

interface IFactoryX {
    function getPool(address, address, uint24) external view returns (address);
    function createPool(address, address, uint24) external returns (address);
}

interface IPoolX {
    function initialize(uint160) external;
    function slot0() external view returns (uint160, int24, uint16, uint16, uint16, uint8, bool);
    function tickSpacing() external view returns (int24);
}

interface INPMX {
    function mint(INonfungiblePositionManager.MintParams calldata) external payable returns (uint256, uint128, uint256, uint256);
    function decreaseLiquidity(INonfungiblePositionManager.DecreaseLiquidityParams calldata) external payable returns (uint256, uint256);
    function collect(INonfungiblePositionManager.CollectParams calldata) external payable returns (uint256, uint256);
    function positions(uint256) external view returns (uint96, address, address, address, uint24, int24, int24, uint128, uint256, uint256, uint128, uint128);
}

interface IPoolLiq { function liquidity() external view returns (uint128); }

interface IRouterX {
    struct P { address tokenIn; address tokenOut; uint24 fee; address recipient; uint256 amountIn; uint256 amountOutMinimum; uint160 sqrtPriceLimitX96; }
    function exactInputSingle(P calldata) external payable returns (uint256);
}

interface IWETHX {
    function deposit() external payable;
    function approve(address, uint256) external returns (bool);
}

contract AuditPoC is Test {
    address constant NPM = 0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3;
    address constant ROUTER = 0xCaf681a66D020601342297493863E78C959E5cb2;
    address constant FACTORY = 0x1f7d7550B1b028f7571E69A784071F0205FD2EfA;
    address constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address constant POOL = 0x52e65B17fB6E5BA00Ed806f37Afcd2DaA50271Ca;

    function setUp() public {
        if (block.chainid != 4663) vm.skip(true);
    }

    /// Gas for a full 40-bin open and close.
    function test_gas40Bins() public {
        LadderManager lm = new LadderManager(NPM, makeAddr("t"), 500);
        address user = makeAddr("user");
        vm.deal(user, 100 ether);
        deal(USDG, user, 1_000_000e6);
        (, int24 t,,,,,) = IPoolX(POOL).slot0();
        LadderManager.Bin[] memory b = new LadderManager.Bin[](40);
        for (uint256 i; i < 40; ++i) {
            // 20 bins below (USDG only), 20 bins above (WETH only), fresh ticks each
            if (i < 20) b[i] = LadderManager.Bin(t - int24(int256(i + 2)) * 7, t - int24(int256(i + 1)) * 7, 0, 100e6);
            else b[i] = LadderManager.Bin(t + int24(int256(i - 19)) * 7 + 7, t + int24(int256(i - 18)) * 7 + 7, 0.05 ether, 0);
        }
        vm.startPrank(user);
        IERC20(USDG).approve(address(lm), type(uint256).max);
        uint256 g = gasleft();
        uint256 id = lm.open{value: 1 ether}(WETH, USDG, 100, b, 10_000, block.timestamp + 60);
        console.log("open 40 gas", g - gasleft());
        g = gasleft();
        lm.close(id, user, false, 0, 0, block.timestamp + 60);
        console.log("close 40 gas", g - gasleft());
        vm.stopPrank();
    }

    function _sqrt(int24 tick) internal pure returns (uint160) {
        // TickMath via StaggerStake's import path
        return TickMathWrap.at_(tick);
    }
}

import {TickMath} from "v3-core/contracts/libraries/TickMath.sol";

library TickMathWrap {
    function at_(int24 t) internal pure returns (uint160) {
        return TickMath.getSqrtRatioAtTick(t);
    }
}
