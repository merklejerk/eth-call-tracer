import * as ethjs from 'ethereumjs-util';
import path from 'path';
import {
    commitCode,
    dupeCode,
    getCodeSize,
    Instruction,
    linkCodes,
    OPCODES,
    parseAsmFileAsync,
    parseBytecode,
    serializeCode,
} from "./evm-compiler";
import { createJumpRouterCode } from './jump-router';

import HOOKS_ARTIFACT from '../out/Runner.sol/SpyHooks.json';

export interface PatchOptions {
    hooksAddress: string;
    origin: string;
}

const SCRATCH_MEM_LOC = 0x8000;
const FAKE_RETURNDATA_MEM_LOC = 0xA000;
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
    ReturnDataCopyPatch = 'returndatacopy-patch',
    ReturnDataSizePatch = 'returndatasize-patch',
}
enum LibFragments {
    CheckedDegateCall = 'checked-delegatecall',
    LogHook = 'log-hook',
    SstoreHook = 'sstore-hook',
    CallHook = 'call-hook',
    ReturnDataCopy = 'returndatacopy',
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

export async function patchBytecodeAsync(
    bytecode: string,
    opts: PatchOptions,
): Promise<string> {
    if (bytecode === '0x') {
        return bytecode;
    }
    const env = {
        'HOOKS_CONTRACT_ADDRESS': opts.hooksAddress,
        'SCRATCH_MEM_LOC': SCRATCH_MEM_LOC,
        'FAKE_RETURNDATA_MEM_LOC': FAKE_RETURNDATA_MEM_LOC,
        'HANDLE_SPY_SSTORE_SELECTOR': HANDLE_SPY_SSTORE_SELECTOR,
        'HANDLE_SPY_LOG_SELECTOR': HANDLE_SPY_LOG_SELECTOR,
        'HANDLE_SPY_CALL_SELECTOR': HANDLE_SPY_CALL_SELECTOR,
        'PREAMBLE_SIZE': 5,
        'HOOK_CALL_FAILED_ERROR': stringToBytes32('hook call failed'),
    };
    const fragments = Object.assign({},
        ...(await Promise.all(ALL_FRAGMENT_NAMES.map(f => parseAsmFragmentAsync(f, env))))
            .map((code, i ) => ({ [ALL_FRAGMENT_NAMES[i]]: code })),
    ) as { [k in AllFragments]: Instruction[] };
    const bytecodeBuf = ethjs.toBuffer(bytecode);
    const runtimeCode: Instruction[] = [
        // Prepend a JUMPDEST for the preamble to jump to.
        { opcode: OPCODES.JUMPDEST, label: '::runtime' },
    ];
    const ops = parseBytecode(bytecodeBuf);
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
            case OPCODES.RETURNDATASIZE:
                // Replace with returndatasize patch.
                runtimeCode.push(...dupeCode(fragments[PatchFragments.ReturnDataSizePatch]));
                break;
            case OPCODES.RETURNDATACOPY:
                // Replace with returndatasize patch.
                runtimeCode.push(...dupeCode(fragments[PatchFragments.ReturnDataCopyPatch]));
                break;
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
                // Copy unmolested.
                runtimeCode.push(op);
        }
    }
    // Create the jump router.
    const jumpRouterCode = createJumpRouterCode(runtimeCode);

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
    // Commit the jump router.   
    bufOffset += commitCode(jumpRouterCode, bufOffset);

    // Link everything.
    linkCodes(
        fragments[PatchFragments.Preamble],
        runtimeCode,
        jumpRouterCode,
        ...LIB_FRAGMENT_NAMES.map(n => fragments[n]),
    );

    // Write everything.
    const outBuf = Buffer.alloc(bufOffset);
    // Write the preamble.
    serializeCode(outBuf, fragments[PatchFragments.Preamble]);
    // Write the original bytecode right after the preamble.
    bytecodeBuf.copy(outBuf, getCodeSize(fragments[PatchFragments.Preamble]));
    // Write the runtime code.
    serializeCode(outBuf, runtimeCode);
    // Write lib fragments.
    for (const name of LIB_FRAGMENT_NAMES) {
        serializeCode(outBuf, fragments[name]);
    }
    // Write the jump router.
    serializeCode(outBuf, jumpRouterCode);
    return ethjs.bufferToHex(outBuf);
}

async function parseAsmFragmentAsync(name: string, env: object): Promise<Instruction[]> {
    const file = path.resolve(__dirname, '..', '..', 'evm', `${name}.evm`);
    return parseAsmFileAsync(file, env);
}

function findSelector(artifact: any, name: string): string {
    for (const sig in artifact.methodIdentifiers) {
        if (/(\w+)\(/.exec(sig)?.[1] === name) {
            return `0x` + artifact.methodIdentifiers[sig];
        }
    }
    throw new Error(`Couldn't find a selector for ${name}!`);
}

function stringToBytes32(s: string): Buffer {
    return ethjs.setLengthRight(Buffer.from(s), 32);
}