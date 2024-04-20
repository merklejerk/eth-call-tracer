import path from 'path';
import fs from 'fs';
import {
    commitCode,
    dupeCode,
    getCodeSize,
    Instruction,
    linkCodes,
    OPCODES,
    disassemble,
    serializeCode,
    assemble,
} from "./evm-assembler";
import { createJumpRouterCode } from './jump-router';

import * as HOOKS_ARTIFACT from '../out/Runner.sol/SpyHooks.json';
import { createExtCodeCopyRouter, createExtCodeHashRouter, createExtCodeSizeRouter } from './ext-router';
import { Hex, toBytes, toHex } from 'viem';

export interface PatchOptions {
    hooksAddress: string;
    origin: string;
    originalStates: { [addr: string]: { code: string, codeHash: string } };
    logsOnly?: boolean;
}

const SCRATCH_MEM_LOC = 0x8000;
enum PatchFragments {
    Preamble = 'preamble',
    JumpPatch = 'jump-patch',
    JumpIPatch = 'jumpi-patch',
    LogPatch = 'log-patch',
    SStorePatch = 'sstore-patch',
    CodeCopyPatch = 'codecopy-patch',
    StaticcallPatch = 'staticcall-patch',
    CallPatch = 'call-patch',
    DelegateCallPatch = 'delegatecall-patch',
    CallCodePatch = 'callcode-patch',
    ExtCodeSizePatch = 'extcodesize-patch',
    ExtCodeCopyPatch = 'extcodecopy-patch',
    ExtCodeHashPatch = 'extcodehash-patch',
}
enum LibFragments {
    CheckedDegateCall = 'checked-delegatecall',
    LogHook = 'log-hook',
    SstoreHook = 'sstore-hook',
    CallHook = 'call-hook',
}
type AllFragments = PatchFragments | LibFragments;
const LIB_FRAGMENT_NAMES = Object.values(LibFragments);
const ALL_FRAGMENT_NAMES = [
    ...Object.values(PatchFragments),
    ...LIB_FRAGMENT_NAMES,
];
const HANDLE_SPY_SSTORE_SELECTOR = findSelector(HOOKS_ARTIFACT, 'handleSpySstore');
const HANDLE_SPY_LOG_SELECTOR = findSelector(HOOKS_ARTIFACT, 'handleSpyLog');
const HANDLE_SPY_CALL_SELECTOR = findSelector(HOOKS_ARTIFACT, 'handleSpyCall');
const RAW_FRAGMENTS = Object.assign(
    {},
    ...ALL_FRAGMENT_NAMES.map(n => ({ [n]: loadAsmFragment(n) })),
);

export function patchBytecode(bytecode: Hex, opts: PatchOptions): Hex {
    if (bytecode === '0x') {
        return bytecode;
    }
    const env = {
        'HOOKS_CONTRACT_ADDRESS': opts.hooksAddress,
        'SCRATCH_MEM_LOC': SCRATCH_MEM_LOC,
        'HANDLE_SPY_SSTORE_SELECTOR': HANDLE_SPY_SSTORE_SELECTOR,
        'HANDLE_SPY_LOG_SELECTOR': HANDLE_SPY_LOG_SELECTOR,
        'HANDLE_SPY_CALL_SELECTOR': HANDLE_SPY_CALL_SELECTOR,
        'PREAMBLE_SIZE': 5,
        'HOOK_CALL_FAILED_ERROR': stringToBytes32('hook call failed'),
    };
    const fragments = Object.assign(
        {},
        ...Object.entries(RAW_FRAGMENTS).map(
            ([n, asm]) => ({ [n]: assemble(asm, env) }),
        ),
    ) as { [k in AllFragments]: Instruction[] };
    const bytecodeBuf = toBytes(bytecode);
    const runtimeCode: Instruction[] = [
        // Prepend a JUMPDEST for the preamble to jump to.
        { opcode: OPCODES.JUMPDEST, label: '::runtime' },
    ];
    const ops = disassemble(bytecodeBuf);
    for (const [i, op] of ops.entries()) {
        switch (op.opcode) {
            case OPCODES.PC:
                // Replace with PUSH3 originalOffset
                runtimeCode.push({ opcode: OPCODES.PUSH3, payload: op.originalOffset! });
                break;
            case OPCODES.JUMP:
                // Replace with a jump patch.
                runtimeCode.push(...dupeCode(fragments[PatchFragments.JumpPatch]));
                break;
            case OPCODES.JUMPI:
                // Replace with a jumpi patch
                runtimeCode.push(...dupeCode(fragments[PatchFragments.JumpIPatch]));
                break;
            case OPCODES.CODESIZE:
                // PUSH2 original codesize.
                runtimeCode.push({ opcode: OPCODES.PUSH2, payload: bytecodeBuf.length });
                break;
            case OPCODES.CODECOPY:
                // Replace with codecopy patch
                runtimeCode.push(...dupeCode(fragments[PatchFragments.CodeCopyPatch]));
                break;
            case OPCODES.EXTCODECOPY:
                // Replace with extcodecopy patch
                runtimeCode.push(...dupeCode(fragments[PatchFragments.ExtCodeCopyPatch]));
                break;
            case OPCODES.EXTCODESIZE:
                // Replace with extcodesize patch
                runtimeCode.push(...dupeCode(fragments[PatchFragments.ExtCodeSizePatch]));
                break;
            case OPCODES.EXTCODEHASH:
                // Replace with extcodehash patch
                runtimeCode.push(...dupeCode(fragments[PatchFragments.ExtCodeHashPatch]));
                break;
            case OPCODES.ORIGIN:
                // PUSH20 fake origin.
                runtimeCode.push({ opcode: OPCODES.PUSH20, payload: opts.origin });
                break;
            case OPCODES.JUMPDEST:
                // Assign a global label.
                runtimeCode.push(
                    { ...op, label: `::__jump__${op.originalOffset}__` },
                );
                break;
            case OPCODES.LOG0:
            case OPCODES.LOG1:
            case OPCODES.LOG2:
            case OPCODES.LOG3:
            case OPCODES.LOG4:
                // Push log size.
                runtimeCode.push({
                    opcode: OPCODES.PUSH1,
                    payload: op.opcode - OPCODES.LOG0,
                });
                // Replace with log patch.
                runtimeCode.push(...dupeCode(fragments[PatchFragments.LogPatch]));
                break;
            default:
                if (!opts.logsOnly) {
                    switch (op.opcode) {
                        case OPCODES.STATICCALL:
                            // Replace with staticcall patch
                            runtimeCode.push(...dupeCode(fragments[PatchFragments.StaticcallPatch]));
                            break;
                        case OPCODES.CALL:
                            // Replace with call patch
                            runtimeCode.push(...dupeCode(fragments[PatchFragments.CallPatch]));
                            break;
                        case OPCODES.DELEGATECALL:
                            // Replace with delegatecall patch
                            runtimeCode.push(...dupeCode(fragments[PatchFragments.DelegateCallPatch]));
                            break;
                        case OPCODES.CALLCODE:
                            // Replace with callcode patch
                            runtimeCode.push(...dupeCode(fragments[PatchFragments.CallCodePatch]));
                            break;
                        case OPCODES.SSTORE:
                            // Replace with sstore patch.
                            runtimeCode.push(...dupeCode(fragments[PatchFragments.SStorePatch]));
                            break;
                        default:
                            // Copy unmolested.
                            runtimeCode.push(op);
                    }
                } else {
                    // Copy unmolested.
                    runtimeCode.push(op);
                }
                
        }
    }
    // Create the router codes.
    const routers = [
        createJumpRouterCode(runtimeCode),
        createExtCodeCopyRouter(Object.assign(
            {},
            ...Object.entries(opts.originalStates).map(
                ([a, s]) => ({
                    [a]: s.code.length === 0
                    // Supposed to be no code. Use a large offset to make it copy 0s.
                    ? 16e6
                    // Otherwise we patched it so skip the preamble.
                    : env.PREAMBLE_SIZE,
                }),
            ),
        )),
        createExtCodeSizeRouter(Object.assign(
            {},
            ...Object.entries(opts.originalStates).map(
                ([a, s]) => ({ [a]: s.code.length }),
            ),
        )),
        createExtCodeHashRouter(Object.assign(
            {},
            ...Object.entries(opts.originalStates).map(
                ([a, s]) => ({ [a]: s.codeHash }),
            ),
        )),
    ];

    // Decide where everything will live.
    let bufOffset = 0;
    // Commit the preamble, which will jump to the runtime code.
    bufOffset += commitCode(fragments[PatchFragments.Preamble], bufOffset);
    // We will write the original bytecode immediately after the preamble,
    // so skip past it for now.
    bufOffset += bytecodeBuf.length;
    // Add 32 zero bytes before the patched runtime code to eat up any metadata that
    // might get interpreted as PUSH payloads.
    bufOffset += 32;
    // Commit the runtime code.
    bufOffset += commitCode(runtimeCode, bufOffset);
    // Commit lib fragments.
    for (const name of LIB_FRAGMENT_NAMES) {
        bufOffset += commitCode(fragments[name], bufOffset);
    }
    // Commit the routers.   
    for (const router of routers) {
        bufOffset += commitCode(router, bufOffset);
    }

    // Link everything.
    linkCodes(
        fragments[PatchFragments.Preamble],
        runtimeCode,
        ...routers,
        ...LIB_FRAGMENT_NAMES.map(n => fragments[n]),
    );

    // Write everything.
    const outBuf = Buffer.alloc(bufOffset);
    // Write the preamble.
    serializeCode(outBuf, fragments[PatchFragments.Preamble]);
    // Write the original bytecode right after the preamble.
    outBuf.set(bytecodeBuf, getCodeSize(fragments[PatchFragments.Preamble]));
    // Write the runtime code.
    serializeCode(outBuf, runtimeCode);
    // Write lib fragments.
    for (const name of LIB_FRAGMENT_NAMES) {
        serializeCode(outBuf, fragments[name]);
    }
    // Write the routers.
    for (const router of routers) {
        serializeCode(outBuf, router);
    }
    return toHex(outBuf);
}

function loadAsmFragment(name: string): string {
    const file = path.resolve(__dirname, '..', '..', 'evm', `${name}.evm`);
    return fs.readFileSync(file, { encoding: 'utf-8' });
}

function findSelector(artifact: any, name: string): string {
    for (const sig in artifact.methodIdentifiers) {
        if (/(\w+)\(/.exec(sig)?.[1] === name) {
            return `0x` + artifact.methodIdentifiers[sig];
        }
    }
    throw new Error(`Couldn't find a selector for ${name}!`);
}

function stringToBytes32(s: string): Uint8Array {
    return toBytes(s, { size: 32 });
}