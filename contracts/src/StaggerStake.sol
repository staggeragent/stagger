// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20Like {
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
    function transferFrom(address, address, uint256) external returns (bool);
}

interface IWETHLike is IERC20Like {
    function withdraw(uint256) external;
}

/// @title StaggerStake
/// @notice Receives the Stagger protocol cut (ETH only) and streams it to $RUNGS stakers over 7 days.
///         No swaps, no oracle, no admin: the deployer can only set the $RUNGS address, once.
contract StaggerStake {
    uint256 public constant DURATION = 7 days;
    uint256 public constant MIN_NOTIFY = 1e14; // 0.0001 ETH: smaller amounts wait so dust cannot keep resetting the stream

    IWETHLike public immutable weth;
    address public immutable deployer;
    IERC20Like public rungs;

    uint256 public totalStaked;
    mapping(address => uint256) public balanceOf;

    uint256 public rewardRate; // wei per second, scaled by 1e18
    uint256 public periodFinish;
    uint256 public lastUpdate;
    uint256 public rewardPerTokenStored; // scaled by 1e36
    mapping(address => uint256) public userRewardPerTokenPaid;
    mapping(address => uint256) public rewards;

    /// ETH already promised: still streaming or earned but unclaimed. balance - committed = new ETH.
    uint256 public committed;

    uint256 private locked = 1;

    event TokenSet(address token);
    event Notified(uint256 added, uint256 rewardRate, uint256 periodFinish);
    event Staked(address indexed user, uint256 amount);
    event Unstaked(address indexed user, uint256 amount);
    event Claimed(address indexed user, uint256 amount);

    error BadParams();
    error NotReady();

    modifier nonReentrant() {
        if (locked != 1) revert BadParams();
        locked = 2;
        _;
        locked = 1;
    }

    modifier update(address account) {
        _update(account);
        _;
    }

    constructor(address _weth) {
        weth = IWETHLike(_weth);
        deployer = msg.sender;
        lastUpdate = block.timestamp;
    }

    receive() external payable {}

    /// @notice One-time: the $RUNGS address exists only after launch.
    function setToken(address token) external {
        if (msg.sender != deployer || address(rungs) != address(0) || token == address(0)) revert BadParams();
        rungs = IERC20Like(token);
        emit TokenSet(token);
    }

    // --------------------------------------------------------------- views

    function lastTimeApplicable() public view returns (uint256) {
        return block.timestamp < periodFinish ? block.timestamp : periodFinish;
    }

    function rewardPerToken() public view returns (uint256) {
        if (totalStaked == 0) return rewardPerTokenStored;
        return rewardPerTokenStored + (lastTimeApplicable() - lastUpdate) * rewardRate * 1e18 / totalStaked;
    }

    function earned(address account) public view returns (uint256) {
        return balanceOf[account] * (rewardPerToken() - userRewardPerTokenPaid[account]) / 1e36 + rewards[account];
    }

    /// ETH waiting to be added to the stream by notify()
    function unstreamed() external view returns (uint256) {
        return address(this).balance - committed;
    }

    // ------------------------------------------------------------- staking

    function stake(uint256 amount) external nonReentrant update(msg.sender) {
        if (address(rungs) == address(0)) revert NotReady();
        if (amount == 0) revert BadParams();
        uint256 before = rungs.balanceOf(address(this));
        _pull(address(rungs), msg.sender, amount);
        amount = rungs.balanceOf(address(this)) - before; // count what arrived (taxed transfers)
        totalStaked += amount;
        balanceOf[msg.sender] += amount;
        emit Staked(msg.sender, amount);
    }

    function unstake(uint256 amount) external nonReentrant update(msg.sender) {
        if (amount == 0 || amount > balanceOf[msg.sender]) revert BadParams();
        totalStaked -= amount;
        balanceOf[msg.sender] -= amount;
        _push(address(rungs), msg.sender, amount);
        emit Unstaked(msg.sender, amount);
    }

    function claim() external nonReentrant update(msg.sender) returns (uint256 amount) {
        amount = rewards[msg.sender];
        if (amount == 0) return 0;
        rewards[msg.sender] = 0;
        committed -= amount;
        (bool ok,) = msg.sender.call{value: amount}("");
        if (!ok) revert BadParams();
        emit Claimed(msg.sender, amount);
    }

    // ------------------------------------------------------------- rewards

    /// @notice Adds new ETH (>= MIN_NOTIFY) to the 7-day stream. Anyone can call.
    function notify() external nonReentrant update(address(0)) {
        uint256 wethBal = weth.balanceOf(address(this));
        if (wethBal > 0) weth.withdraw(wethBal);
        uint256 added = address(this).balance - committed;
        if (added < MIN_NOTIFY) return;
        committed += added;
        uint256 leftover = block.timestamp < periodFinish ? (periodFinish - block.timestamp) * rewardRate : 0;
        rewardRate = (added * 1e18 + leftover) / DURATION;
        periodFinish = block.timestamp + DURATION;
        lastUpdate = block.timestamp;
        emit Notified(added, rewardRate, periodFinish);
    }

    // ------------------------------------------------------------ internal

    function _update(address account) internal {
        uint256 applicable = lastTimeApplicable();
        if (totalStaked == 0 && applicable > lastUpdate) {
            // nobody staked during this stretch: release it so the next notify() streams it again
            committed -= (applicable - lastUpdate) * rewardRate / 1e18;
        }
        rewardPerTokenStored = rewardPerToken();
        lastUpdate = applicable;
        if (account != address(0)) {
            rewards[account] = earned(account);
            userRewardPerTokenPaid[account] = rewardPerTokenStored;
        }
    }

    function _pull(address token, address from, uint256 amount) internal {
        (bool ok, bytes memory data) = token.call(abi.encodeCall(IERC20Like.transferFrom, (from, address(this), amount)));
        if (!ok || (data.length > 0 && !abi.decode(data, (bool)))) revert BadParams();
    }

    function _push(address token, address to, uint256 amount) internal {
        (bool ok, bytes memory data) = token.call(abi.encodeCall(IERC20Like.transfer, (to, amount)));
        if (!ok || (data.length > 0 && !abi.decode(data, (bool)))) revert BadParams();
    }
}
