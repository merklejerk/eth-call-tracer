'use strict'
require('colors');
require('dotenv').config();
const ethjs = require('ethereumjs-util');
const crypto = require('crypto');
const { env: ENV } = require('process');
const FlexContract = require('flex-contract');
const FlexEther = require('flex-ether');

const RUNNER_ARTIFACT = require('../out/Runner.sol/Runner.json');
const ORIGIN_ARTIFACT = require('../out/Runner.sol/Origin.json');
const HOOKS_ARTIFACT = require('../out/Runner.sol/SpyHooks.json');
const { write } = require('fs');

const NULL_ADDRESS = '0x0000000000000000000000000000000000000000';
const NULL_BYTES = '0x';
const RUNNER_ADDRESS = '0x9000000000000000000000000000000000000001';
const HOOKS_ADDRESS = '0x9000000000000000000000000000000000000002';
const HANDLE_SPY_SSTORE_SELECTOR = findSelector(HOOKS_ARTIFACT, 'handleSpySstore');
const HANDLE_SPY_LOG_SELECTOR = findSelector(HOOKS_ARTIFACT, 'handleSpyLog');


require('yargs').command('$0', 'run', yargs =>
    yargs
        .option('rpc-url', { type: 'string', desc: 'node RPC url' })
        .option('from', { type: 'string', desc: 'TX caller', default: NULL_ADDRESS })
        .option('to', { type: 'string', desc: 'TX target', default: NULL_ADDRESS })
        .option('value', { type: 'string', desc: 'TX value', default: 0 })
        .option('block', { type: 'number', desc: 'block number', default: 0 })
        .option('gas-price', { type: 'number', desc: 'gas price (gwei)', default: 0 })
        .option('data', { type: 'string', desc: 'TX data', default: NULL_BYTES }),
    argv => run(argv),
).argv;

async function run(argv) {
    const rpcUrl = argv.rpcUrl || ENV.NODE_RPC;
    if (!rpcUrl) {
        throw new Error(`no RPC URL set!`);
    }
    const eth = new FlexEther({ providerURI: rpcUrl });
    const runner = new FlexContract(
        RUNNER_ARTIFACT.abi,
        RUNNER_ADDRESS,
        { eth },
    );
    const block = argv.block || await eth.getBlockNumber();
    const targetCode = await eth.getCode(argv.to);
    
    const r = await runner.run(
        {
            txOrigin: argv.from,
            txTo: argv.to,
            txValue: argv.value,
            txData: argv.data,
            txGas: 100e6,
            txGasPrice: 0
        },
    ).call(
        {
            overrides: {
                [argv.from]: { code: ORIGIN_ARTIFACT.deployedBytecode.object },
                [runner.address]: { code: RUNNER_ARTIFACT.deployedBytecode.object },
                [argv.to]: { code: transformBytecode(targetCode, HOOKS_ADDRESS, argv.from) },
                [HOOKS_ADDRESS]: { code: HOOKS_ARTIFACT.deployedBytecode.object },
            },
        },
    );
    console.log(JSON.stringify(r, null, '\t'));
}

const CallType = {
    Call: 0,
    Static: 1,
    Delegate: 2,
    Code: 4,
};

const OP_CALL = 0xF1;
const OP_CALLCODE = 0xF2;
const OP_DELEGATECALL = 0xF4;
const OP_STATICCALL = 0xFA;
const OP_PUSH1 = 0x60;
const OP_PUSH2 = 0x61;
const OP_PUSH3 = 0x62;
const OP_PUSH20 = 0x73;
const OP_PUSH32 = 0x7F;
const OP_JUMP = 0x56;
const OP_JUMPI = 0x57;
const OP_DUP1 = 0x80;
const OP_DUP2 = 0x81;
const OP_DUP3 = 0x82;
const OP_DUP4 = 0x83;
const OP_DUP5 = 0x84;
const OP_DUP6 = 0x85;
const OP_DUP7 = 0x86;
const OP_DUP8 = 0x87;
const OP_CODESIZE = 0x38;
const OP_CODECOPY = 0x39;
const OP_STOP = 0x00;
const OP_INVALID = 0xFE;
const OP_REVERT = 0xFD;
const OP_SELFDESTRUCT = 0xFF;
const OP_RETURN = 0xF3;
const OP_PC = 0x58;
const OP_SWAP1 = 0x90;
const OP_SWAP2 = 0x91;
const OP_SWAP3 = 0x92;
const OP_SWAP4 = 0x93;
const OP_SWAP5 = 0x94;
const OP_SWAP6 = 0x95;
const OP_SWAP7 = 0x96;
const OP_SWAP8 = 0x97;
const OP_POP = 0x50;
const OP_SHR = 0x1C;
const OP_ADD = 0x01;
const OP_MUL = 0x02;
const OP_SUB = 0x03;
const OP_DIV = 0x04;
const OP_MLOAD = 0x51;
const OP_MSTORE = 0x52;
const OP_MSTORE8 = 0x53;
const OP_AND = 0x16;
const OP_GAS = 0x5A;
const OP_ORIGIN = 0x32;
const OP_JUMPDEST = 0x5B;
const OP_SLOAD = 0x54;
const OP_SSTORE = 0x55;
const OP_ISZERO = 0x15;
const OP_LT = 0x10;
const OP_GT = 0x11;
const OP_EQ = 0x14;
const OP_LOG0 = 0xA0;
const OP_LOG1 = 0xA1;
const OP_LOG2 = 0xA2;
const OP_LOG3 = 0xA3;
const OP_LOG4 = 0xA4;

function splitCode(codeBuf) {
    let currBlock = [];
    const blocks = [currBlock];
    let i = 0;
    for (i = 0; i < codeBuf.length; ++i) {
        const op = codeBuf[i];
        switch (op) {
            case OP_JUMPDEST:
                blocks.push(currBlock = [{ opcode: op, offset: i }]);
                break;
            // TODO: check for unregistered opcodes and close block.
            //       Maybe also JUMPs?
            case OP_INVALID:
            case OP_SELFDESTRUCT:
            case OP_STOP:
            case OP_REVERT:
            case OP_RETURN:
                if (currBlock) {
                    currBlock.push({ opcode: op, offset: i });
                    currBlock = null;
                }
                break;
            default:
                if (currBlock) {
                    let n = 0;
                    if (op >= OP_PUSH1 && op <= OP_PUSH32) {
                        n = op - OP_PUSH1 + 1;
                    }
                    if (n > 0) {
                        const fullOpCode = [op];
                        const end = Math.min(codeBuf.length, i + n + 1);
                        for (let j = i + 1; j < end; ++j) {
                            fullOpCode.push(codeBuf[j]);
                        }
                        currBlock.push({ opcode: fullOpCode, offset: i });
                    } else {
                        currBlock.push({ opcode: op, offset: i });
                    }
                    i += n;
                }
                break;
        }
    }
    return blocks;
}

function toByteArray(n, size) {
    return [...ethjs.toBuffer(ethjs.setLengthLeft(ethjs.toBuffer(n), size))];
}

function to2ByteArray(n) {
    return toByteArray(n, 2);
}

function to3ByteArray(n) {
    return toByteArray(n, 3);
}

function to20ByteArray(n) {
    return toByteArray(n, 20);
}

function to32ByteArray(n) {
    return toByteArray(n, 32);
}

function getCodeBlockSize(block) {
    let size = 0;
    for (const op of iterBlockOps(block)) {
        ++size;
    }
    return size;
}

function writeBlock(buf, offset, block) {
    let o = offset;
    for (const op of iterBlockOps(block)) {
        buf[o++] = op;
    }
    return o - offset;
}

function* iterBlockOps(block) {
    for (const [idx, op] of block.entries()) {
        if (Array.isArray(op)) {
            for (const op_ of op) {
                yield op_;
            }
        } else if (typeof(op) === 'number') {
            yield op;
        } else {
            if (Array.isArray(op.opcode)) {
                for (const op_ of op.opcode) {
                    yield op_;
                }
            } else {
                yield op.opcode;
            }
        }
    }
}

function* iterBlocksOps(blocks) {
    for (const block of blocks) {
        for (const op of iterBlockOps(block)) {
            yield op;
        }
    }
}

function stringToBytes32(s) {
    return ethjs.bufferToHex(ethjs.setLengthRight(Buffer.from(s), 32));
}

function transformBytecode(code, hooksAddress, origin) {
    const PREAMBLE_SIZE = 5;
    const SCRATCH_MEM_LOC = 0x100;

    // +------------------------+-------------------------+---------------+
    // | section                | description             | size (bytes)  |
    // +------------------------+-------------------------+---------------+
    // | preamble               | jump to new code        | 4             |
    // | deployed code          | original code           | len(code)     |
    // | jump remap table       | original                | len(code) * 3 |
    // +------------------------+-------------------------+---------------+
    // |                        NEW CODE                                  |
    // +------------------------+-------------------------+---------------+
    // | JUMP router code       | jump table lookup code  | TODO          |
    // | JUMPI router code      | jumpi table lookup code | TODO          |
    // | checked delegatecaller | <-                      | TODO          |
    // | SSTORE hook code       | <-                      | TODO          |
    // | LOG hook code          | <-                      | TODO          |
    // +------------------------+-------------------------+---------------+

    const codeBuf = ethjs.toBuffer(code);

    let scratchOffset = PREAMBLE_SIZE + codeBuf.length;
    
    const jumpRemapOffset = scratchOffset;
    scratchOffset += codeBuf.length * 3;

    const extraCodeOffset = scratchOffset;

    const jumpRouterOffset = scratchOffset;
    // The router block looks up the correct jump position in the
    // jump remap table.
    const jumpRouterBlock = [
        OP_JUMPDEST,
        // 3, offset
        [OP_PUSH1, 3],
        // offset, 3
        OP_SWAP1,
        // 3, offset, 3
        OP_DUP2,
        // offset', 3
        OP_MUL,
        // jumpRemapOffset, offset', 3
        [OP_PUSH3, ...to3ByteArray(jumpRemapOffset)],
        // offset'', 3
        OP_ADD,
        // ptr, offset'', 3
        [OP_PUSH2, ...to2ByteArray(SCRATCH_MEM_LOC)],
        OP_CODECOPY,
        // ptr
        [OP_PUSH2, ...to2ByteArray(SCRATCH_MEM_LOC)],
        // JMP_OFFSET_32
        OP_MLOAD,
        // 232, JMP_OFFSET_32
        [OP_PUSH1, 232],
        // JMP_OFFSET
        OP_SHR,
        OP_JUMP,
    ];
    scratchOffset += getCodeBlockSize(jumpRouterBlock);

    const jumpIRouterOffset = scratchOffset;
    const jumpIRouterBlock = [
        // jumpback, loc, bool
        OP_JUMPDEST,
        // bool, loc, jumpback
        OP_SWAP2,
        // loc, bool, jumpback
        OP_SWAP1,
        // Copy everything between JUMPDEST and JUMP in the jump router.
        ...jumpRouterBlock.slice(1, -1),
        OP_JUMPI,
        // Return to jumpback if JUMPI is not triggered
        OP_JUMP
    ];
    scratchOffset += getCodeBlockSize(jumpIRouterBlock);

    const checkedDelegatecallOffset = scratchOffset;
    const checkedDelegatecallBlock = [
        // argSize, jumpback
        OP_JUMPDEST,
        // retSize, argSize, jumpback
        [OP_PUSH1, 0],
        // retOffset, retSize, argSize, jumpback
        [OP_PUSH1, 0],
        // retSize, retOffset, argSize, jumpback
        OP_SWAP1,
        // argSize, retOffset, retSize, jumpback
        OP_SWAP2,
        // argOffset, argSize, retOffset, retSize, jumpback
        [OP_PUSH2, ...to2ByteArray(SCRATCH_MEM_LOC)],
        // target, argOffset, argSize, retOffset, retSize, jumpback
        [OP_PUSH20, ...to20ByteArray(hooksAddress)],
        // gas, target, argOffset, argSize, retOffset, retSizejumpback
        OP_GAS,
        // success, jumpback
        OP_DELEGATECALL,
        // !success, jumpback
        OP_ISZERO,
        // PC, !success, jumpback
        OP_PC,
        // 46, PC, !success, jumpback
        [OP_PUSH1, 6],
        // jumpdest, !success, jumpback
        OP_ADD,
        OP_JUMPI,
        // :successful
        // jumpback
        OP_JUMP,
        OP_JUMPDEST,
        // :failed
        // errmsg, jumpback 
        [OP_PUSH32, ...to32ByteArray(stringToBytes32('hook call failed'))],
        // 0x00, errmsg, jumpback
        [OP_PUSH1, 0x00],
        // jumpback
        OP_MSTORE,
        // 0x20, jumpback
        [OP_PUSH1, 0x20],
        // 0x00, 0x20, jumpback
        [OP_PUSH1, 0x00],
        // jumpback
        OP_REVERT,
    ]
    scratchOffset += getCodeBlockSize(checkedDelegatecallBlock);
    
    const sstoreHookOffset = scratchOffset;
    const sstoreHookBlock = [
        // jumpback, slot, value
        OP_JUMPDEST,
        // value, slot, jumpback
        OP_SWAP2,
        // slot, value, jumpback
        OP_SWAP1,
        // Encode a delegatecall to handleSpySstore()
        // selector, slot, value, jumpback
        [OP_PUSH32, ...to32ByteArray(ethjs.setLengthRight(HANDLE_SPY_SSTORE_SELECTOR, 32))],
        // ptr, selector, slot, value, jumpback
        [OP_PUSH2, ...to2ByteArray(SCRATCH_MEM_LOC)],
        // slot, value, jumpback
        OP_MSTORE,
        // ptr+0x04, slot, value, jumpback
        [OP_PUSH2, ...to2ByteArray(SCRATCH_MEM_LOC + 0x04)],
        // value, jumpback
        OP_MSTORE,
        // ptr+0x24, value, jumpback
        [OP_PUSH2, ...to2ByteArray(SCRATCH_MEM_LOC + 0x24)],
        // jumpback
        OP_MSTORE,
        // argSize, jumpback
        [OP_PUSH1, 0x44],
        // checkedDelegateCallJumpDest, argSize, jumpback
        [OP_PUSH3, ...to3ByteArray(checkedDelegatecallOffset)],
        // argSize, jumpback
        OP_JUMP,
    ];
    scratchOffset += getCodeBlockSize(sstoreHookBlock);

    const logHookOffset = scratchOffset;
    const logHookBlock = [
        // jumpback, numTopics, dataOffset, dataSize, ...
        OP_JUMPDEST,
        // numTopics, jumpback, dataOffset, dataSize, ...
        OP_SWAP1,
        // Encode a delegatecall to handleSpyLog()
        // selector, numTopics, jumpback, dataOffset, dataSize, ...
        [OP_PUSH32, ...to32ByteArray(ethjs.setLengthRight(HANDLE_SPY_LOG_SELECTOR, 32))],
        // ptr, selector, numTopics, jumpback, dataOffset, dataSize, ...
        [OP_PUSH2, ...to2ByteArray(SCRATCH_MEM_LOC)],
        // numTopics, jumpback, dataOffset, dataSize, ...
        OP_MSTORE, // Store selector
        // numTopics, numTopics, jumpback, dataOffset, dataSize, ...
        OP_DUP1,
        // ptr, numTopics, numTopics, jumpback, dataOffset, dataSize, ...
        [OP_PUSH2, ...to2ByteArray(SCRATCH_MEM_LOC + 0x04)],
        // numTopics, jumpback, dataOffset, dataSize, ...
        OP_MSTORE, // Store numTopics
        
        // Fill the topic calldatas with 0s
        [OP_PUSH1, 0],
        [OP_PUSH2, ...to2ByteArray(SCRATCH_MEM_LOC + 0x24)],
        OP_MSTORE,
        [OP_PUSH1, 0],
        [OP_PUSH2, ...to2ByteArray(SCRATCH_MEM_LOC + 0x44)],
        OP_MSTORE,
        [OP_PUSH1, 0],
        [OP_PUSH2, ...to2ByteArray(SCRATCH_MEM_LOC + 0x64)],
        OP_MSTORE,
        [OP_PUSH1, 0],
        [OP_PUSH2, ...to2ByteArray(SCRATCH_MEM_LOC + 0x84)],
        OP_MSTORE,

        // i, numTopics, jumpback, dataOffset, dataSize, ...
        [OP_PUSH1, 0],
        OP_JUMPDEST, // :loop
            // escape
            // numTopics, i, numTopics, jumpback, dataOffset, dataSize, ...
            OP_DUP2,
            // i, numTopics, i, numTopics, jumpback, dataOffset, dataSize, ...
            OP_DUP2,
            // i == numTopics, i, numTopics, jumpback, dataOffset, dataSize, ...
            OP_EQ,
            // ?, i == numTopics, i, numTopics, jumpback, dataOffset, dataSize, ...
            [OP_PUSH1, 25],
            // PC, ?, i == numTopics, i, numTopics, jumpback, dataOffset, dataSize, ...
            OP_PC,
            // :loop, i == numTopics, i, numTopics, jumpback, dataOffset, dataSize, ...
            OP_ADD,
            // i, numTopics, jumpback, dataOffset, dataSize, ...
            OP_JUMPI, // -> :out

            // copy topic
            // numTopics, i, jumpback, dataOffset, dataSize, topic, ...
            OP_SWAP1,
            // jumpback, i, numTopics, dataOffset, dataSize, topic, ...
            OP_SWAP2,
            // dataOffset, i, numTopics, jumpback, dataSize, topic, ...
            OP_SWAP3,
            // dataSize, i, numTopics, jumpback, dataOffset, topic, ...
            OP_SWAP4,
            // topic, i, numTopics, jumpback, dataOffset, dataSize, ...
            OP_SWAP5,
            // ptr, topic, i, numTopics, jumpback, dataOffset, dataSize, ...
            [OP_PUSH2, ...to2ByteArray(SCRATCH_MEM_LOC + 0x24)],
            // 0x20, ptr, topic, i, numTopics, jumpback, dataOffset, dataSize, ...
            [OP_PUSH1, 0x20],
            // i, 0x20, ptr, topic, i, numTopics, jumpback, dataOffset, dataSize, ...
            OP_DUP4,
            // i*0x20, ptr, topic, i, numTopics, jumpback, dataOffset, dataSize, ...
            OP_MUL,
            // ptr+i*0x20, topic, i, numTopics, jumpback, dataOffset, dataSize, ...
            OP_ADD,
            // i, numTopics, jumpback, dataOffset, dataSize, ...
            OP_MSTORE, // store topic

            // i += 1
            // 1, i, numTopics, jumpback, dataOffset, dataSize, ...
            [OP_PUSH1, 1],
            // i + 1, numTopics, jumpback, dataOffset, dataSize, ...
            OP_ADD,
            
            // re-loop
            // ?, i, numTopics, jumpback, dataOffset, dataSize, ...
            [OP_PUSH1, 28],
            // PC, ?, i, numTopics, jumpback, dataOffset, dataSize, ...
            OP_PC,
            // :loop, i, numTopics, jumpback, dataOffset, dataSize, ...
            OP_SUB,
            // i, numTopics, jumpback, dataOffset, dataSize, ...
            OP_JUMP, // -> :loop
        OP_JUMPDEST, // :out
        // numTopics, jumpback, dataOffset, dataSize
        OP_POP,

        // jumpback, dataOffset, dataSize
        OP_POP,
        // dataSize, dataOffset, jumpback
        OP_SWAP2,

        // copy data arg offset
        // 0xC0, dataSize, dataOffset, jumpback
        [OP_PUSH1, 0xC0],
        // dstDataOffsetOffset, 0xC0, dataSize, dataOffset, jumpback
        [OP_PUSH2, ...to2ByteArray(SCRATCH_MEM_LOC + 0xA4)],
        // dataSize, dataOffset, jumpback
        OP_MSTORE,

        // copy data length prefix
        // dataSize, dataSize, dataOffset, jumpback
        OP_DUP1,
        // dstDataSizeOffset, dataSize, dataSize, dataOffset, jumpback
        [OP_PUSH2, ...to2ByteArray(SCRATCH_MEM_LOC + 0xC4)],
        // dataSize, dataOffset, jumpback
        OP_MSTORE,

        // i, dataSize, dataOffset, jumpback
        [OP_PUSH1, 0],
        OP_JUMPDEST, // :dataloop
            // escape
            // dataSize, i, dataSize, dataOffset, jumpback
            OP_DUP2,
            // i, dataSize, i, dataSize, dataOffset, jumpback
            OP_DUP2,
            // i < dataSize, i, dataSize, dataOffset, jumpback
            OP_LT,
            // i >= dataSize, i, dataSize, dataOffset, jumpback
            OP_ISZERO,
            // PC, ?, i >= dataSize, i, dataSize, dataOffset, jumpback
            [OP_PUSH1, 21],
            // PC, ?, i >= dataSize, i, dataSize, dataOffset, jumpback
            OP_PC, 
            // :dataloopout, i >= dataSize, i, dataSize, dataOffset, jumpback
            OP_ADD,
            // i, dataSize, dataOffset, jumpback
            OP_JUMPI, // -> :dataloopout

            // copy data word
            // dataOffset, i, dataSize, dataOffset, jumpback
            OP_DUP1,
            // i, dataOffset, i, dataSize, dataOffset, jumpback
            OP_DUP2,
            // srcOffset, i, dataSize, dataOffset, jumpback
            OP_ADD,
            // dataWord, i, dataSize, dataOffset, jumpback
            OP_MLOAD,
            // dstOffset_start, dataWord, i, dataSize, dataOffset, jumpback
            [OP_PUSH2, ...to2ByteArray(SCRATCH_MEM_LOC + 0xE4)],
            // i, dstOffset_start, dataWord, i, dataSize, dataOffset, jumpback
            OP_DUP3,
            // dstOffset, dataWord, i, dataSize, dataOffset, jumpback
            OP_ADD,
            // i, dataSize, dataOffset, jumpback
            OP_MSTORE, // store word of data

            // i += 0x20
            // 0x20, i, dataSize, dataOffset, jumpback
            [OP_PUSH1, 0x20],
            // i+0x20, dataSize, dataOffset, jumpback
            OP_ADD,

            // re-loop
            // ?, i, dataSize, dataOffset, jumpback
            [OP_PUSH1, 25],
            // PC, ?, i, dataSize, dataOffset, jumpback
            OP_PC,
            // :dataloop, i, dataSize, dataOffset, jumpback
            OP_SUB,
            // i, dataSize, dataOffset, jumpback
            OP_JUMP, // -> :dataloop
        OP_JUMPDEST, // :dataloopout

        // 0xE4, i, dataSize, dataOffset, jumpback
        [OP_PUSH1, 0xE4],
        // argSize, dataSize, dataOffset, jumpback
        OP_ADD,
        //  dataOffset, dataSize, argSize, jumpback
        OP_SWAP2,
        //  dataSize, argSize, jumpback
        OP_POP,
        // argSize, jumpback
        OP_POP,
        // checkedDelegateCallJumpDest, argSize jumpback
        [OP_PUSH3, ...to3ByteArray(checkedDelegatecallOffset)],
        // argSize, jumpback
        OP_JUMP,
    ];
    scratchOffset += getCodeBlockSize(logHookBlock);

    // TODO push to this so they stay in order.
    const extraCodeBlocks = [
        jumpRouterBlock,
        jumpIRouterBlock,
        checkedDelegatecallBlock,
        sstoreHookBlock,
        logHookBlock,
    ];

    const patchedCodeOffset = scratchOffset;

    const jumpToJumpRouterOpcodes = [
        [OP_PUSH3, ...to3ByteArray(jumpRouterOffset)],
        OP_JUMP,
    ];
    const jumpToJumpIRouterOpcodes = [
        // 7, loc, bool
        [OP_PUSH1, 7],
        // pc, 7, loc, bool
        OP_PC,
        // jumpback, loc, bool
        OP_ADD,
        [OP_PUSH3, ...to3ByteArray(jumpIRouterOffset)],
        OP_JUMP,
        OP_JUMPDEST,
    ];
    const jumpToSStoreHookOpcodes = [
        // 7, slot, value
        [OP_PUSH1, 7],
        // pc, 7, slot, value
        OP_PC,
        // jumpback, slot, value
        OP_ADD,
        // sstoreHookOffset, jumpback, slot, value
        [OP_PUSH3, ...to3ByteArray(sstoreHookOffset)],
        OP_JUMP,
        OP_JUMPDEST,
    ];
    const jumpToLogHookOpcodes = [
        // 7, numTopics, ...
        [OP_PUSH1, 7],
        // pc, 7, numTopics, ...
        OP_PC,
        // jumpback, numTopics, ...
        OP_ADD,
        // logHookOffset, jumpback, numTopics, ...
        [OP_PUSH3, ...to3ByteArray(logHookOffset)],
        OP_JUMP,
        OP_JUMPDEST,
    ];

    const patchedCodeBlocks = splitCode(codeBuf).map(block => {
        const patchedBlock = [];
        for (const op of block) {
            if (!Array.isArray(op.opcode)) {
                // Single-byte ops (non-PUSH)
                switch (op.opcode) {
                    case OP_PC:
                        // Replace with PUSH3 <op.offset>
                        patchedBlock.push([OP_PUSH3, ...to3ByteArray(op.offset)]);
                        break;
                    case OP_JUMP:
                        // Replace with a jump to the JUMP router block.
                        patchedBlock.push(...jumpToJumpRouterOpcodes);
                        break;
                    case OP_JUMPI:
                        // Replace with a jump to the JUMPI router block.
                        patchedBlock.push(...jumpToJumpIRouterOpcodes);
                        break;
                    case OP_CODESIZE:
                        // PUSH3 original codesize.
                        patchedBlock.push([OP_PUSH3, ...to3ByteArray(codeBuf.length)]);
                        break;
                    case OP_CODECOPY:
                        // Offset src by preamble.
                        patchedBlock.push(
                            // copyDst, codeOffset, size
                            // codeOffset, copyDst, codeOffset, size
                            OP_DUP2,
                            // PREAMBLE_SIZE, codeOffset, copyDst, codeOffset, size
                            [OP_PUSH1, PREAMBLE_SIZE],
                            // codeOffset', copyDst, codeOffset, size
                            OP_ADD,
                            // codeOffset, copyDst, codeOffset', size
                            OP_SWAP2,
                            // copyDst, codeOffset', size
                            OP_POP,
                            OP_CODECOPY,
                        );
                        break;
                    case OP_ORIGIN:
                        // PUSH20 fake origin.
                        patchedBlock.push([PUSH20, ...to20ByteArray(origin)]);
                        break;
                    case OP_SSTORE:
                        patchedBlock.push(...jumpToSStoreHookOpcodes);
                        break;
                    case OP_LOG0:
                    case OP_LOG1:
                    case OP_LOG2:
                    case OP_LOG3:
                    case OP_LOG4:
                        patchedBlock.push(
                            [OP_PUSH1, op.opcode - OP_LOG0],
                            ...jumpToLogHookOpcodes
                        );
                        break;
                    default:
                        patchedBlock.push(op);
                }
            } else {
                // PUSH opcodes
                patchedBlock.push(op);
            }
        }
        return patchedBlock;
    });
    // Prepend a JUMPDEST to the first patched code block for the preamble to jump to.
    if (patchedCodeBlocks[0]) {
        const firstBlock = patchedCodeBlocks[0];
        const op = patchedCodeBlocks[0];
        if (op !== OP_JUMPDEST && op?.op !== OP_JUMPDEST) {
            firstBlock.unshift(OP_JUMPDEST);
        }
    }
    scratchOffset += getTotalBlocksSize(patchedCodeBlocks);
    
    // Write the final output code.
    const outputCodeBuf = Buffer.alloc(scratchOffset);
    // Write preamble to jump to the patched entry point at `patchedCodeOffset`
    writeBlock(
        outputCodeBuf,
        0,
        [
            [OP_PUSH3, ...to3ByteArray(patchedCodeOffset)],
            OP_JUMP,
        ],
    );
    // Write original code right after the preamble.
    // This is to keep codecopies working.
    codeBuf.copy(outputCodeBuf, PREAMBLE_SIZE, 0, codeBuf.length);
    {
        // Write the extra code blocks starting at `extraCodeOffset`.
        let o = extraCodeOffset;
        for (const block of extraCodeBlocks) {
            o += writeBlock(
                outputCodeBuf,
                o,
                block,
            );
        }
    }
    {
        // Write the patched code blocks starting at `patchedCodeOffset`
        // and update the jump remap table as we go.
        let o = patchedCodeOffset;
        for (const block of patchedCodeBlocks) {
            // TODO: can be wrong for first block
            if (block[0]?.offset !== undefined && block[0].opcode === OP_JUMPDEST) {
                const key = block[0].offset * 3 + jumpRemapOffset;
                outputCodeBuf.writeUIntBE(o, key, 3);
            }
            o += writeBlock(
                outputCodeBuf,
                o,
                block,
            );
        }
    }
    // console.log([ ...outputCodeBuf].map(s => ethjs.toBuffer([s]).toString('hex')).join('_'));
    return ethjs.bufferToHex(outputCodeBuf);
}

function getTotalBlocksSize(blocks) {
    return blocks.reduce(
        (total, block) => total + getCodeBlockSize(block),
        0,
    );
}

function findSelector(artifact, name) {
    for (const sig in artifact.methodIdentifiers) {
        if (/(\w+)\(/.exec(sig)[1] === name) {
            return `0x` + artifact.methodIdentifiers[sig];
        }
    }
    throw new Error(`Couldn't find a selector for ${name}!`);
}