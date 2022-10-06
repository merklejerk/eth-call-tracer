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

const NULL_ADDRESS = '0x0000000000000000000000000000000000000000';
const NULL_BYTES = '0x';
const RUNNER_ADDRESS = '0x9000000000000000000000000000000000000001';
const HOOKS_ADDRESS = '0x9000000000000000000000000000000000000002';
const HANDLE_SPY_SSTOR_SELECTOR = findSelector(HOOKS_ARTIFACT, 'handleSpySstore');


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
        ethjs.bufferToHex(crypto.randomBytes(20)),
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
                [argv.to]: { code: transformBytecode(targetCode, HOOKS_ADDRESS, argv.from) }
            },
        },
    );
    console.log(r);
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

function splitCode(codeBuf) {
    let currBlock = [];
    const blocks = [currBlock];
    for (let i = 0; i < codeBuf.length; ++i) {
        const op = codeBuf[i];
        switch (op) {
            case OP_JUMPDEST:
                blocks.push(currBlock = [{ opcode: op, offset: i }]);
                break;
            // TODO: check for unregistered opcodes
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
                            fullOpCode.push(codeBuf[i]);
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
    for (const op of block) {
        if (Array.isArray(op)) {
            size += op.length;
        } else if (typeof(op) === 'number') {
            size++;
        } else {
            if (Array.isArray(op.opcode)) {
                size += op.opcode.length;
            } else {
                size++;
            }
        }
    }
    return size;
}

function writeBlock(buf, offset, block) {
    let o = offset;
    for (const op of block) {
        if (Array.isArray(op)) {
            for (const op_ of op) {
                buf[o++] = op_;
            }
        } else if (typeof(op) === 'number') {
            buf[o++] = op;
        } else {
            if (Array.isArray(op.opcode)) {
                for (const op_ of op.opcode) {
                    buf[o++] = op_;
                }
            } else {
                buf[o++] = op.opcode;
            }
        }
    }
    return o - offset;
}

function transformBytecode(code, hooksAddress, origin) {
    const PREAMBLE_SIZE = 5;
    const SCRATCH_MEM_LOC = 0x8080;

    // +-------------------+-------------------------+---------------+
    // | section           | description             | size (bytes)  |
    // +-------------------+-------------------------+---------------+
    // | preamble          | jump to new code        | 4             |
    // | deployed code     | original code           | len(code)     |
    // | jump remap table  | original                | len(code) * 3 |
    // +-------------------+-------------------------+---------------+
    // |                     NEW CODE                                |
    // +-------------------------------------------------------------+
    // | JUMP router code  | jump table lookup code  | 24            |
    // | JUMPI router code | jumpi table lookup code | 24            |
    // | SSTORE hook code  | <-                      | TODO          |
    // +-------------------+-------------------------+---------------+

    let codeBuf = ethjs.toBuffer(code);

    let scratchOffset = PREAMBLE_SIZE + codeBuf.length;
    
    const jumpRemapOffset = scratchOffset;
    scratchOffset += codeBuf.length * 3;

    const extraCodeOffset = scratchOffset;

    const jumpRouterOffset = scratchOffset;
    // The router block looks up the correct jump position in the
    // jump remap table.
    const jumpRouterBlock = [
        OP_JUMPDEST,
        // // 3, offset
        // [OP_PUSH1, 3],
        // // mul(3, offset) -> offset'
        // OP_MUL,
        // // jumpRemapOffset, offset'
        // [OP_PUSH3, ...to3ByteArray(jumpRemapOffset)],
        // // add(jumpDataOffset, offset') -> offset''
        // OP_ADD,
        // // ptr, offset'', 3
        // [OP_PUSH2, ...to2ByteArray(SCRATCH_MEM_LOC)],
        // OP_CODECOPY,
        // // ptr
        // [OP_PUSH2, ...to2ByteArray(SCRATCH_MEM_LOC)],
        // // JMP_OFFSET_32
        // OP_MLOAD,
        // // 232, JMP_OFFSET_32
        // [OP_PUSH1, 232],
        // // JMP_OFFSET
        // OP_SHR,
        // [OP_PUSH2, ...to2ByteArray(SCRATCH_MEM_LOC)],
        // OP_MLOAD,
        [OP_PUSH1, 0],
        OP_MSTORE,
        [OP_PUSH1, 0x20],
        [OP_PUSH1, 0],
        OP_RETURN,
        OP_JUMP,
    ];
    scratchOffset += getCodeBlockSize(jumpRouterBlock);

    const jumpIRouterOffset = scratchOffset;
    const jumpIRouterBlock = [
        // Same as jumpRouterBlock but with a JUMPI instead of JUMP at the end.
        ...jumpRouterBlock.slice(0, -1),
        OP_JUMPI,
    ];
    scratchOffset += getCodeBlockSize(jumpIRouterBlock);

    console.log(jumpIRouterOffset);

    const sstoreHookOffset = scratchOffset;
    const sstoreHookBlock = [
        OP_JUMPDEST,
        // jumpback, slot, value
        // value, slot, jumpback
        OP_SWAP2,
        // slot, value, jumpback
        OP_SWAP1,
        // Encode a delegatecall to handleSpySstore()
        // handleSpyCall.selector, slot, value, jumpback
        [OP_PUSH32, ...to32ByteArray()],
        // ptr, handleSpyCall.selector, slot, value, jumpback
        [OP_PUSH2, ...to2ByteArray(SCRATCH_MEM_LOC)],
        // slot, value, jumpback
        OP_MSTORE,
        // ptr+0x04, slot, value, jumpback
        [OP_PUSH2, ...to2ByteArray(SCRATCH_MEM_LOC + 0x04)],
        // value, jumpback
        OP_MSTORE,
        // ptr+0x24, value, jumpback
        [OP_PUSH2, ...to2ByteArray(SCRATCH_MEM_LOC + 0x24)],
        OP_MSTORE,
        // Perform the delegatecall
        // retSize, jumpback
        [OP_PUSH1, 0],
        // retOffset, retSize, jumpback
        [OP_PUSH1, 0],
        // argSize, retOffset, retSize, jumpback
        [OP_PUSH1, 0x44],
        // argOffset, argSize, retOffset, retSize, jumpback
        [OP_PUSH1, ...to2ByteArray(SCRATCH_MEM_LOC)],
        // target, argOffset, argSize, retOffset, retSize, jumpback
        [OP_PUSH1, ...to20ByteArray(hooksAddress)],
        // gas, target, argOffset, argSize, retOffset, retSize, jumpback
        OP_GAS,
        // success, jumpback
        OP_DELEGATECALL,
        // jumpback, success
        OP_SWAP1,
        OP_JUMP,
    ];
    scratchOffset += getCodeBlockSize(sstoreHookBlock);

    const extraCodeBlocks = [
        jumpRouterBlock,
        jumpIRouterBlock,
        sstoreHookBlock,
    ];

    const patchedCodeOffset = scratchOffset;

    const jumpToJumpRouterOpcodes = [
        [OP_PUSH3, ...to3ByteArray(jumpRouterOffset)],
        OP_JUMP,
    ];
    const jumpToJumpIRouterOpcodes = [
        [OP_PUSH3, ...to3ByteArray(jumpIRouterOffset)],
        OP_JUMP,
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
                    // case OP_SSTORE:
                    //     patchedBlock.push(...jumpToSStoreHookOpcodes);
                    //     break;
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
                console.log(block[0].offset, key, o);
                outputCodeBuf.writeUIntBE(key, o, 3);
            }
            o += writeBlock(
                outputCodeBuf,
                o,
                block,
            );
        }
    }
    // writeBlock(
    //     outputCodeBuf,
    //     patchedCodeOffset + 1,
    //     [
    //         [OP_PUSH3, ...to3ByteArray(PREAMBLE_SIZE)],
    //         OP_JUMP,
    //     ],
    // );
    console.log(outputCodeBuf.slice(0, 10));
    console.log(outputCodeBuf.slice(extraCodeOffset, extraCodeOffset + 10));
    console.log(outputCodeBuf.slice(patchedCodeOffset, patchedCodeOffset + 10));
    console.log(scratchOffset);
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
            return `0x` + artifact.methodIdentifiers;
        }
    }
    throw new Error(`Couldn't find a selector for ${name}!`);
}