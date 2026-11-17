// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
    function transferFrom(address, address, uint256) external returns (bool);
    function approve(address, uint256) external returns (bool);
}

interface IWETH9 is IERC20 {
    function deposit() external payable;
    function withdraw(uint256) external;
}

interface IUniswapV3Factory {
    function getPool(address, address, uint24) external view returns (address);
}

interface INonfungiblePositionManager {
    struct MintParams {
        address token0;
        address token1;
        uint24 fee;
        int24 tickLower;
        int24 tickUpper;
        uint256 amount0Desired;
        uint256 amount1Desired;
        uint256 amount0Min;
        uint256 amount1Min;
        address recipient;
        uint256 deadline;
    }

    struct DecreaseLiquidityParams {
        uint256 tokenId;
        uint128 liquidity;
        uint256 amount0Min;
        uint256 amount1Min;
        uint256 deadline;
    }

    struct CollectParams {
        uint256 tokenId;
        address recipient;
        uint128 amount0Max;
        uint128 amount1Max;
    }

    function factory() external view returns (address);
    function WETH9() external view returns (address);
    function mint(MintParams calldata) external payable returns (uint256, uint128, uint256, uint256);
    function decreaseLiquidity(DecreaseLiquidityParams calldata) external payable returns (uint256, uint256);
    function collect(CollectParams calldata) external payable returns (uint256, uint256);
    function burn(uint256) external payable;
    function positions(uint256)
        external
        view
        returns (uint96, address, address, address, uint24, int24, int24, uint128, uint256, uint256, uint128, uint128);
}

/// @title LadderManager
/// @notice Opens a "ladder" of 1-40 Uniswap v3 positions in one transaction and holds them for the owner.
///         Bin amounts are computed off-chain (by the range agent or the user); the contract only checks,
///         mints, collects and returns funds. The protocol cut applies only to swap fees collected in ETH, never to
///         principal, and is fixed at deploy. No admin, no proxy, no upgrade.
contract LadderManager {
    uint256 public constant MAX_BINS = 40;
    uint256 public constant MAX_FEE_BPS = 1000; // 10% hard cap

    INonfungiblePositionManager public immutable npm;
    IWETH9 public immutable weth;
    address public immutable factory;
    address public immutable feeRecipient;
    uint256 public immutable feeBps;

    struct Bin {
        int24 tickLower;
        int24 tickUpper;
        uint256 amount0;
        uint256 amount1;
    }

    struct Ladder {
        address owner;
        address token0;
        address token1;
        uint24 fee;
        uint256[] tokenIds;
    }

    uint256 public nextLadderId = 1;
    mapping(uint256 => Ladder) internal ladders;
    mapping(address => uint256[]) internal ownerLadders;

    uint256 private locked = 1;

    event Opened(uint256 indexed ladderId, address indexed owner, address pool, uint256 bins);
    event Claimed(uint256 indexed ladderId, uint256 fee0, uint256 fee1, uint256 cut0, uint256 cut1);
    event Withdrawn(uint256 indexed ladderId, uint256 bins, uint256 amount0, uint256 amount1);
    event Closed(uint256 indexed ladderId);

    error NotOwner();
    error BadParams();
    error Expired();
    error EthMismatch();
    error TransferFailed();
    error Slippage();

    modifier nonReentrant() {
        if (locked != 1) revert BadParams();
        locked = 2;
        _;
        locked = 1;
    }

    modifier onlyOwner(uint256 ladderId) {
        if (ladders[ladderId].owner != msg.sender) revert NotOwner();
        _;
    }

    constructor(address _npm, address _feeRecipient, uint256 _feeBps) {
        if (_feeBps > MAX_FEE_BPS || _feeRecipient == address(0)) revert BadParams();
        npm = INonfungiblePositionManager(_npm);
        weth = IWETH9(INonfungiblePositionManager(_npm).WETH9());
        factory = INonfungiblePositionManager(_npm).factory();
        feeRecipient = _feeRecipient;
        feeBps = _feeBps;
    }

    receive() external payable {
        if (msg.sender != address(weth)) revert BadParams();
    }

    // ------------------------------------------------------------------ open

    /// @param token0 must be the pool's token0 (lower address)
    /// @param bins   each bin is minted as one position; amounts are desired amounts for that bin
    /// @param slippageBps applied per bin to amountMin
    /// @dev If msg.value > 0, one side must be WETH and msg.value must equal that side's total.
    function open(
        address token0,
        address token1,
        uint24 fee,
        Bin[] calldata bins,
        uint256 slippageBps,
        uint256 deadline
    ) external payable nonReentrant returns (uint256 ladderId) {
        if (block.timestamp > deadline) revert Expired();
        if (bins.length == 0 || bins.length > MAX_BINS || token0 >= token1 || slippageBps > 10_000) {
            revert BadParams();
        }
        address pool = IUniswapV3Factory(factory).getPool(token0, token1, fee);
        if (pool == address(0)) revert BadParams();

        uint256 total0;
        uint256 total1;
        for (uint256 i; i < bins.length; ++i) {
            if (bins[i].tickLower >= bins[i].tickUpper) revert BadParams();
            total0 += bins[i].amount0;
            total1 += bins[i].amount1;
        }

        bool paidEth = msg.value > 0;
        _pullIn(token0, total0, paidEth);
        _pullIn(token1, total1, paidEth);
        if (paidEth && !((token0 == address(weth) && msg.value == total0) || (token1 == address(weth) && msg.value == total1)))
        {
            revert EthMismatch();
        }

        _safeApprove(token0, address(npm), total0);
        _safeApprove(token1, address(npm), total1);

        ladderId = nextLadderId++;
        Ladder storage l = ladders[ladderId];
        l.owner = msg.sender;
        l.token0 = token0;
        l.token1 = token1;
        l.fee = fee;

        for (uint256 i; i < bins.length; ++i) {
            Bin calldata b = bins[i];
            (uint256 tokenId,,,) = npm.mint(
                INonfungiblePositionManager.MintParams({
                    token0: token0,
                    token1: token1,
                    fee: fee,
                    tickLower: b.tickLower,
                    tickUpper: b.tickUpper,
                    amount0Desired: b.amount0,
                    amount1Desired: b.amount1,
                    amount0Min: b.amount0 * (10_000 - slippageBps) / 10_000,
                    amount1Min: b.amount1 * (10_000 - slippageBps) / 10_000,
                    recipient: address(this),
                    deadline: deadline
                })
            );
            l.tokenIds.push(tokenId);
        }
        ownerLadders[msg.sender].push(ladderId);

        _safeApprove(token0, address(npm), 0);
        _safeApprove(token1, address(npm), 0);

        // refund what the pool did not take
        _refund(token0, msg.sender, paidEth);
        _refund(token1, msg.sender, paidEth);

        emit Opened(ladderId, msg.sender, pool, bins.length);
    }

    // ----------------------------------------------------------------- claim

    /// @notice Collects swap fees from every bin; the fixed cut goes to feeRecipient, the rest to `to`.
    /// @param asWeth true = receive WETH as the ERC20; false = receive native ETH.
    function claim(uint256 ladderId, address to, bool asWeth)
        external
        nonReentrant
        onlyOwner(ladderId)
        returns (uint256 out0, uint256 out1)
    {
        if (to == address(0)) revert BadParams();
        Ladder storage l = ladders[ladderId];
        uint256 fee0;
        uint256 fee1;
        for (uint256 i; i < l.tokenIds.length; ++i) {
            (uint256 a0, uint256 a1) = _collect(l, l.tokenIds[i]);
            fee0 += a0;
            fee1 += a1;
        }
        (out0, out1) = _payFees(ladderId, l, fee0, fee1, to, asWeth);
    }

    // -------------------------------------------------------------- withdraw

    /// @notice Removes the bins at `indices` (positions in the ladder's bin list, strictly descending).
    ///         Principal returns in full; fees earned by those bins take the fixed cut.
    ///         Removing bins reorders the remaining list (swap-and-pop): re-read getLadder afterwards.
    /// @param min0 / min1 minimum principal to receive in total (slippage guard).
    function withdraw(
        uint256 ladderId,
        uint256[] calldata indices,
        address to,
        bool asWeth,
        uint256 min0,
        uint256 min1,
        uint256 deadline
    ) external nonReentrant onlyOwner(ladderId) {
        _withdraw(ladderId, indices, to, asWeth, min0, min1, deadline);
    }

    /// @notice Removes every bin. The ladder record stays, with no bins.
    function close(uint256 ladderId, address to, bool asWeth, uint256 min0, uint256 min1, uint256 deadline)
        external
        nonReentrant
        onlyOwner(ladderId)
    {
        uint256 n = ladders[ladderId].tokenIds.length;
        uint256[] memory idx = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            idx[i] = n - 1 - i;
        }
        _withdraw(ladderId, idx, to, asWeth, min0, min1, deadline);
        emit Closed(ladderId);
    }

    function _withdraw(
        uint256 ladderId,
        uint256[] memory indices,
        address to,
        bool asWeth,
        uint256 min0,
        uint256 min1,
        uint256 deadline
    ) internal {
        if (block.timestamp > deadline) revert Expired();
        if (to == address(0)) revert BadParams();
        Ladder storage l = ladders[ladderId];
        uint256[4] memory acc; // principal0, principal1, fee0, fee1
        uint256 prev = type(uint256).max;
        for (uint256 k; k < indices.length; ++k) {
            uint256 i = indices[k];
            if (i >= prev || i >= l.tokenIds.length) revert BadParams(); // strictly descending, in range
            prev = i;
            uint256 tokenId = l.tokenIds[i];
            (,,,,,,, uint128 liq,,,,) = npm.positions(tokenId);
            uint256 p0;
            uint256 p1;
            if (liq > 0) {
                (p0, p1) = npm.decreaseLiquidity(
                    INonfungiblePositionManager.DecreaseLiquidityParams(tokenId, liq, 0, 0, deadline)
                );
            }
            // what actually arrived (a token taxing transfers can deliver less than the pool reports)
            (uint256 c0, uint256 c1) = _collect(l, tokenId);
            uint256 r0 = c0 < p0 ? c0 : p0;
            uint256 r1 = c1 < p1 ? c1 : p1;
            acc[0] += r0;
            acc[1] += r1;
            acc[2] += c0 - r0;
            acc[3] += c1 - r1;
            npm.burn(tokenId);
            l.tokenIds[i] = l.tokenIds[l.tokenIds.length - 1];
            l.tokenIds.pop();
        }
        if (acc[0] < min0 || acc[1] < min1) revert Slippage();
        _send(l.token0, to, acc[0], asWeth);
        _send(l.token1, to, acc[1], asWeth);
        _payFees(ladderId, l, acc[2], acc[3], to, asWeth);
        emit Withdrawn(ladderId, indices.length, acc[0], acc[1]);
    }

    // ----------------------------------------------------------------- views

    function getLadder(uint256 ladderId)
        external
        view
        returns (address owner, address token0, address token1, uint24 fee, uint256[] memory tokenIds)
    {
        Ladder storage l = ladders[ladderId];
        return (l.owner, l.token0, l.token1, l.fee, l.tokenIds);
    }

    function laddersOf(address owner) external view returns (uint256[] memory) {
        return ownerLadders[owner];
    }

    // -------------------------------------------------------------- internal

    /// @dev Returns the amounts that actually arrived, measured by balance.
    function _collect(Ladder storage l, uint256 tokenId) internal returns (uint256 got0, uint256 got1) {
        uint256 b0 = IERC20(l.token0).balanceOf(address(this));
        uint256 b1 = IERC20(l.token1).balanceOf(address(this));
        npm.collect(
            INonfungiblePositionManager.CollectParams(tokenId, address(this), type(uint128).max, type(uint128).max)
        );
        got0 = IERC20(l.token0).balanceOf(address(this)) - b0;
        got1 = IERC20(l.token1).balanceOf(address(this)) - b1;
    }

    function _payFees(uint256 ladderId, Ladder storage l, uint256 fee0, uint256 fee1, address to, bool asWeth)
        internal
        returns (uint256 out0, uint256 out1)
    {
        // the protocol cut is taken only from fees paid in ETH (WETH); fees in any other token go 100% to the owner
        uint256 cut0 = l.token0 == address(weth) ? fee0 * feeBps / 10_000 : 0;
        uint256 cut1 = l.token1 == address(weth) ? fee1 * feeBps / 10_000 : 0;
        // the cut never blocks the owner: if it cannot be delivered, the owner gets it
        if (cut0 > 0 && !_trySendCut(cut0)) cut0 = 0;
        if (cut1 > 0 && !_trySendCut(cut1)) cut1 = 0;
        out0 = fee0 - cut0;
        out1 = fee1 - cut1;
        _send(l.token0, to, out0, asWeth);
        _send(l.token1, to, out1, asWeth);
        emit Claimed(ladderId, fee0, fee1, cut0, cut1);
    }

    /// @dev Sends `amount` of WETH to feeRecipient as native ETH; on failure re-wraps and returns false.
    function _trySendCut(uint256 amount) internal returns (bool ok) {
        weth.withdraw(amount);
        (ok,) = feeRecipient.call{value: amount}("");
        if (!ok) weth.deposit{value: amount}();
    }

    function _pullIn(address token, uint256 amount, bool paidEth) internal {
        if (amount == 0) return;
        if (paidEth && token == address(weth)) {
            weth.deposit{value: msg.value}();
        } else {
            _safeTransferFrom(token, msg.sender, address(this), amount);
        }
    }

    function _refund(address token, address to, bool paidEth) internal {
        uint256 bal = IERC20(token).balanceOf(address(this));
        if (bal == 0) return;
        _send(token, to, bal, !paidEth);
    }

    /// @dev WETH leaves as native ETH unless asWeth.
    function _send(address token, address to, uint256 amount, bool asWeth) internal {
        if (amount == 0) return;
        if (token == address(weth) && !asWeth) {
            weth.withdraw(amount);
            (bool ok,) = to.call{value: amount}("");
            if (!ok) revert TransferFailed();
        } else {
            _safeTransfer(token, to, amount);
        }
    }

    function _safeTransfer(address token, address to, uint256 amount) internal {
        (bool ok, bytes memory data) = token.call(abi.encodeCall(IERC20.transfer, (to, amount)));
        if (!ok || (data.length > 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }

    function _safeTransferFrom(address token, address from, address to, uint256 amount) internal {
        (bool ok, bytes memory data) = token.call(abi.encodeCall(IERC20.transferFrom, (from, to, amount)));
        if (!ok || (data.length > 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }

    /// @dev Works with tokens whose approve returns nothing (USDT-style).
    function _safeApprove(address token, address spender, uint256 amount) internal {
        (bool ok, bytes memory data) = token.call(abi.encodeCall(IERC20.approve, (spender, amount)));
        if (!ok || (data.length > 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }

    function onERC721Received(address, address, uint256, bytes calldata) external view returns (bytes4) {
        if (msg.sender != address(npm)) revert BadParams();
        return this.onERC721Received.selector;
    }
}
