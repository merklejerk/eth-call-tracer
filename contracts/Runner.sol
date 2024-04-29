// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

contract Spy {
    enum CallType {
        Call,
        Static,
        Delegate,
        Code
    }

    struct Spy_CALL {
        uint256 index;
        address context;
        CallType callType;
        address to;
        uint256 value;
        uint256 gas;
        bytes data;
        bytes result;
        bool success;
        uint256 gasUsed;
    }

    struct Spy_SLOAD {
        uint256 index;
        address context;
        uint256 slot;
        bytes32 value;
    }

    struct Spy_SSTORE {
        uint256 index;
        address context;
        uint256 slot;
        bytes32 oldValue;
        bytes32 value;
    }

    struct Spy_LOG {
        uint256 index;
        address context;
        uint8 numTopics;
        bytes32[4] topics;
        bytes data;
    }

    struct Spy_CREATE {
        uint256 index;
        address context;
        bytes createData;
        address deployed;
        uint256 gasUsed;
    }

    struct Spy_CREATE2 {
        uint256 index;
        address context;
        bytes createData;
        bytes32 salt;
        address deployed;
        uint256 gasUsed;
    }

    uint256 public nextHookIndex;
    Spy_CALL[] internal spy_calls;
    Spy_SLOAD[] internal spy_sloads;
    Spy_SSTORE[] internal spy_sstores;
    Spy_LOG[] internal spy_logs;
    Spy_CREATE[] internal spy_creates;
    Spy_CREATE2[] internal spy_create2s;

    receive() external payable {}

    function onSpyCall(Spy_CALL memory spied) external virtual {
        spy_calls.push(spied);
    }

    function onSpySstore(Spy_SSTORE memory spied) external virtual {
        spy_sstores.push(spied);
    }

    function onSpyLog(Spy_LOG memory spied) external virtual {
        spy_logs.push(spied);
    }

    function consumeNextHookIndex() external returns (uint256) {
        return nextHookIndex++;
    }
}

contract SpyHooks {
    Spy constant SPY = Spy(payable(0x9000000000000000000000000000000000000001));

    uint256 constant CALL_GAS_OVERHEAD = 0; // TODO
    function handleSpyCall(
        Spy.CallType callType,
        uint256 gas_,
        address payable to,
        uint256 value,
        bytes memory data
    ) external payable returns (bool success, bytes memory resultData, uint256 gasUsed) {
        bool isStaticCtx = _isStaticCallContext();
        uint256 idx;
        if (!isStaticCtx) {
            idx = SPY.consumeNextHookIndex();
        }
        assembly {
            switch callType
            case 0 { // CallType.Call
                gasUsed := gas()
                success := call(gas(), to, value, add(data, 0x20), mload(data), 0, 0)
            }
            case 1 { // CallType.Static
                gasUsed := gas()
                // Must use call or else nested hooked calls will fail.
                success := call(gas(), to, value, add(data, 0x20), mload(data), 0, 0)
            }
            case 2 { // CallType.Delegate
                gasUsed := gas()
                success := delegatecall(gas(), to, add(data, 0x20), mload(data), 0, 0)
            }
            default { // case CallType.Code (3)
                gasUsed := gas()
                success := callcode(gas(), to, value, add(data, 0x20), mload(data), 0, 0)
            }
            gasUsed := sub(sub(gasUsed, gas()), CALL_GAS_OVERHEAD)
            resultData := mload(0x40)
            mstore(0x40, add(resultData, add(returndatasize(), 0x20)))
            mstore(resultData, returndatasize())
            returndatacopy(add(resultData, 0x20), 0, returndatasize())
        }
        if (!isStaticCtx) {
            SPY.onSpyCall(Spy.Spy_CALL({
                index: idx,
                context: address(this),
                callType: callType,
                to: to,
                value: value,
                gas: gas_,
                data: data,
                result: resultData,
                success: success,
                gasUsed: gasUsed
            }));
        }
    }

    function _isStaticCallContext() private returns (bool isStaticCtx) {
        assembly ("memory-safe") {
            mstore(0x00, shl(0x72ca127b, 224)) // this.__tryLog.selector
            pop(call(address(), 0, gas(), 0x00, 0x04, 0x00, 0))
            isStaticCtx := eq(returndatasize(), 1)
        }
    }

    function __tryLog() external payable {
        assembly ("memory-safe") {
            log0(0x00, 0)
            return(0x00, 1)
        }
    }

    uint256 constant LOG0_GAS_OVERHEAD = 0; // TODO
    uint256 constant LOG1_GAS_OVERHEAD = 0; // TODO
    uint256 constant LOG2_GAS_OVERHEAD = 0; // TODO
    uint256 constant LOG3_GAS_OVERHEAD = 0; // TODO
    uint256 constant LOG4_GAS_OVERHEAD = 0; // TODO

    function handleSpyLog(
        uint8 numTopics,
        bytes32 topic1,
        bytes32 topic2,
        bytes32 topic3,
        bytes32 topic4,
        bytes memory data
    ) external payable returns (uint256 gasUsed) {
        if (numTopics == 0) {
            assembly {
                gasUsed := gas()
                log0(add(data, 0x20), mload(data))
                gasUsed := sub(sub(gas(), gasUsed), LOG0_GAS_OVERHEAD)
            }
        } else if (numTopics == 1) {
            assembly {
                gasUsed := gas()
                log1(add(data, 0x20), mload(data), topic1)
                gasUsed := sub(sub(gas(), gasUsed), LOG1_GAS_OVERHEAD)
            }
        } else if (numTopics == 2) {
            assembly {
                gasUsed := gas()
                log2(add(data, 0x20), mload(data), topic1, topic2)
                gasUsed := sub(sub(gas(), gasUsed), LOG2_GAS_OVERHEAD)
            }
        } else if (numTopics == 3) {
            assembly {
                gasUsed := gas()
                log3(add(data, 0x20), mload(data), topic1, topic2, topic3)
                gasUsed := sub(sub(gas(), gasUsed), LOG3_GAS_OVERHEAD)
            }
        } else if (numTopics == 3) {
            assembly {
                gasUsed := gas()
                log4(add(data, 0x20), mload(data), topic1, topic2, topic3, topic4)
                gasUsed := sub(sub(gas(), gasUsed), LOG4_GAS_OVERHEAD)
            }
        }
        SPY.onSpyLog(Spy.Spy_LOG({
            index: SPY.consumeNextHookIndex(),
            context: address(this),
            numTopics: numTopics,
            topics: [topic1, topic2, topic3, topic4],
            data: data
        }));
    }

    uint256 constant SSTORE_GAS_OVERHEAD = 13; // TODO

    function handleSpySstore(
        uint256 slot,
        bytes32 value
    ) external payable returns (uint256 gasUsed) {
        bytes32 oldValue;
        assembly {
            oldValue := sload(slot)
            gasUsed := gas()
            sstore(slot, value)
            gasUsed := sub(sub(gas(), gasUsed), SSTORE_GAS_OVERHEAD)
        }
        SPY.onSpySstore(Spy.Spy_SSTORE({
            index: SPY.consumeNextHookIndex(),
            context: address(this),
            slot: slot,
            oldValue: oldValue,
            value: value
        }));
    }
}

contract Origin {
    address constant RUNNER_ADDRESS = 0x9000000000000000000000000000000000000001;

    function call(address target, uint256 value, bytes calldata data)
        external
        returns (bool success, bytes memory returnData)
    {
        if (msg.sender != 0x9000000000000000000000000000000000000001) {
            assembly { return(0x00, 0x00) }
        }
        (success, returnData) = target.call{value: value}(data);
    }

    fallback(bytes calldata) external payable returns (bytes memory) {
        return "";
    }

    receive() external payable {}
}

contract Runner is Spy {
    
    struct RunContext {
        Origin txOrigin;
        address txTo;
        uint256 txValue;
        bytes txData;
        uint256 txGas;
        uint256 txGasPrice;
    }

    struct RunResult {
        bool success;
        bytes returnData;
        Spy_CALL[] spy_calls;
        Spy_SLOAD[] spy_sloads;
        Spy_SSTORE[] spy_sstores;
        Spy_LOG[] spy_logs;
    }

    bool is2929Enabled;
    bool isPoS;
    mapping (address => bool) isKnownAddress;

    function run(RunContext calldata ctx) external returns (RunResult memory result) {
        require(msg.sender == tx.origin, 'INVALID_RUN_CALLER');
        _setup();
        (result.success, result.returnData) =
            ctx.txOrigin.call(ctx.txTo, ctx.txValue, ctx.txData);
        result.spy_calls = spy_calls;
        result.spy_sstores = spy_sstores;
        result.spy_sloads = spy_sloads;
        result.spy_logs = spy_logs;
    }

    function runIterative(
        RunContext calldata ctx,
        address[] memory knownAddresses
    )
        external returns (
            RunResult memory result,
            bytes[] memory unknownBytecodes
        )
    {
        require(msg.sender == tx.origin, 'INVALID_RUN_CALLER');
        _setup();
        (result.success, result.returnData) =
            ctx.txOrigin.call(ctx.txTo, ctx.txValue, ctx.txData);
        result.spy_calls = spy_calls;
        result.spy_sstores = spy_sstores;
        result.spy_sloads = spy_sloads;
        result.spy_logs = spy_logs;

        for (uint256 i; i < knownAddresses.length; ++i) {
            isKnownAddress[knownAddresses[i]] = true;
        }
        uint256 numUnknowns;
        for (uint256 i; i < result.spy_calls.length; ++i) {
            Spy_CALL memory c = result.spy_calls[i];
            if (c.callType == CallType.Static || !c.success) {
                continue;
            }
            address callee = c.to;
            if (!isKnownAddress[callee]) {
                ++numUnknowns;
            }
        }
        unknownBytecodes = new bytes[](numUnknowns);
        for (uint256 i; i < result.spy_calls.length; ++i) {
            Spy_CALL memory c = result.spy_calls[i];
            if (c.callType == CallType.Static || !c.success) {
                continue;
            }
            address callee = c.to;
            if (isKnownAddress[callee]) {
                continue;
            }
            isKnownAddress[callee] = true;
            // Store in reverse order.
            unknownBytecodes[--numUnknowns] = callee.code;
        }
    }

    function _setup() private {
        is2929Enabled = _detect2929();
        isPoS = _detect2929();
    }

    function _detectPoS() private view returns (bool) {
        return block.prevrandao > type(uint128).max;
    }

    function _detect2929() private view returns (bool) {
        uint256 slot = _randomUint256();
        uint256 gasUsed = gasleft();
        assembly { pop(sload(slot)) }
        gasUsed = gasUsed - gasleft();
        return gasUsed > 1e3;
    }

    function _randomUint256() private view returns (uint256) {
        return uint256(keccak256(abi.encode(msg.data, gasleft(), block.prevrandao, tx.origin)));
    }
}
