import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import { toBytes } from 'viem';

export const OPCODES = {
    CALL: 0xF1,
    CALLCODE: 0xF2,
    DELEGATECALL: 0xF4,
    STATICCALL: 0xFA,
    PUSH1: 0x60,
    PUSH2: 0x61,
    PUSH3: 0x62,
    PUSH4: 0x63,
    PUSH20: 0x73,
    PUSH32: 0x7F,
    JUMP: 0x56,
    JUMPI: 0x57,
    DUP1: 0x80,
    DUP2: 0x81,
    DUP3: 0x82,
    DUP4: 0x83,
    DUP5: 0x84,
    DUP6: 0x85,
    DUP7: 0x86,
    DUP8: 0x87,
    CODESIZE: 0x38,
    EXTCODESIZE: 0x3B,
    EXTCODECOPY: 0x3C,
    EXTCODEHASH: 0x3F,
    CODECOPY: 0x39,
    STOP: 0x00,
    INVALID: 0xFE,
    REVERT: 0xFD,
    SELFDESTRUCT: 0xFF,
    RETURN: 0xF3,
    PC: 0x58,
    SWAP1: 0x90,
    SWAP2: 0x91,
    SWAP3: 0x92,
    SWAP4: 0x93,
    SWAP5: 0x94,
    SWAP6: 0x95,
    SWAP7: 0x96,
    SWAP8: 0x97,
    SWAP9: 0x98,
    SWAP10: 0x99,
    SWAP11: 0x9A,
    SWAP12: 0x9B,
    POP: 0x50,
    SHL: 0x1B,
    SHR: 0x1C,
    ADD: 0x01,
    MUL: 0x02,
    SUB: 0x03,
    DIV: 0x04,
    MLOAD: 0x51,
    MSTORE: 0x52,
    MSTORE8: 0x53,
    AND: 0x16,
    OR: 0x17,
    NOT: 0x19,
    GAS: 0x5A,
    ORIGIN: 0x32,
    JUMPDEST: 0x5B,
    SLOAD: 0x54,
    SSTORE: 0x55,
    ISZERO: 0x15,
    LT: 0x10,
    GT: 0x11,
    EQ: 0x14,
    LOG0: 0xA0,
    LOG1: 0xA1,
    LOG2: 0xA2,
    LOG3: 0xA3,
    LOG4: 0xA4,
    RETURNDATACOPY: 0x3E,
    RETURNDATASIZE: 0x3D,
    DATA: -1,
}

const VALID_PUSH_COMMANDS = Object.assign(
    {},
    // PUSH1-PUSH32
    ...(() => [...new Array(32)].map((v, i) => ({[`PUSH${i + 1}`] : true })))(),
);

const LABEL_REGEX = /^::?[\w-_]+$/;
const PUSH_PARAM_REGEXES = [
    LABEL_REGEX,
    /^\d+$/,
    /^0x[a-f0-9]{2,64}$/i,
    /^\$[-_a-z0-1]+$/i,
];

export interface Instruction {
    opcode: number;
    payload?: Uint8Array | string | number;
    label?: string;
    originalOffset?: number;
    offset?: number;
    scopeId?: string;
}

export async function assembleFileAsync(file, env={}): Promise<Instruction[]> {
    return assemble(await fs.readFile(file, { encoding: 'utf-8' }), env);
}

export function assemble(asm, env={}): Instruction[] {
    const instructions = [] as Instruction[];
    const scopeId = randomId();
    let nextLabel: string | null = null;
    for (const line of asm.split(/\r?\n/)) {
        const words = /^(.*?)(\/\/.*)?$/.exec(line)?.[1]
            .split(/\s+/)
            .map(word => word.trim())
            .filter(word => word && word.length)
        if (!words.length) {
            continue;
        }
        if (LABEL_REGEX.test(words[0])) {
            nextLabel = words[0];
            continue;
        }
        const op = words[0].toUpperCase();
        if (!(op in OPCODES)) {
            throw new Error(`Unknown EVM instruction: ${op}`);
        }
        if (op in VALID_PUSH_COMMANDS) {
            const r = /^PUSH(\d+)$/.exec(words[0]);
            if (!r) {
                throw new Error(`Invalid PUSH command: ${op}`);
            }
            if (!PUSH_PARAM_REGEXES.some(r => r.test(words[1]))) {
                throw new Error(`Invalid PUSH param: ${words[1]}`);
            }
            let rawPayload = words[1];
            if (words[1].startsWith('$')) {
                rawPayload = env[words[1].slice(1)];
                if (rawPayload === undefined) {
                    throw new Error(`Encountered undefined asm variable: ${words[1]}`);
                }
            }
            if (rawPayload === 'undefined') {
                throw new Error(`Missing asm reference: ${words[1]}`);
            }
            instructions.push({
                opcode: OPCODES[op],
                payload: /^-?\d+$/.test(rawPayload) ? Number(rawPayload) : rawPayload,
                scopeId: scopeId,
            });
        } else {
            instructions.push({
                opcode: OPCODES[op],
                scopeId: scopeId,
            });
        }
        if (nextLabel) {
            instructions[instructions.length - 1].label = nextLabel;
            nextLabel = null;
        }
    }
    return instructions;
}

export function randomId(): string {
    return crypto.randomBytes(16).toString('hex');
}

export function disassemble(bytecode: Uint8Array): Instruction[] {
    const instructions = [] as Instruction[];
    let currentBlock = [];
    let currentScopeId = randomId();
    for (let i = 0; i < bytecode.length; ++i) {
        const op = bytecode[i];
        const inst = {
            opcode: op,
            scopeId: currentScopeId,
            originalOffset: i,
        } as Instruction;
        switch (op) {
            case OPCODES.JUMPDEST:
                if (!currentScopeId) {
                    inst.scopeId = currentScopeId = randomId();
                }
                currentBlock.push(inst);
                break;
            // TODO: check for unregistered opcodes and currentBlock block.
            case OPCODES.JUMP:
            case OPCODES.INVALID:
            case OPCODES.SELFDESTRUCT:
            case OPCODES.STOP:
            case OPCODES.REVERT:
            case OPCODES.RETURN:
                if (currentScopeId) {
                    currentBlock.push(inst);
                    instructions.push(...currentBlock);
                    currentBlock = [];
                    currentScopeId = undefined;
                }
                break;
            default:
                if (currentScopeId) {
                    const n = getOpcodePayloadSize(op);
                    if (n > 0) {
                        if (bytecode.length < i + 1 + n) {
                            console.warn(`illegal payload size`);
                            // Payload doesn't exist.
                            // Abort the currentBlock block.
                            currentBlock = [];
                            currentScopeId = undefined;
                            break;
                        }
                        inst.payload = bytecode.slice(i + 1, i + 1 + n);
                    }
                    i += n;
                    currentBlock.push(inst);
                } else {
                    // No scope ID means we've hit the end of the code and are in
                    // the data section. Stop disassembling.
                    i = bytecode.length - 1;
                }
                break;
        }
    }
    return instructions;
}

export function isPushOpcode(opcode): boolean {
    return opcode >= OPCODES.PUSH1 && opcode <= OPCODES.PUSH32;
}

export function getOpcodePayloadSize(opcode): number {
    if (isPushOpcode(opcode)) {
        return opcode - OPCODES.PUSH1 + 1;
    }
    return 0;
}

export function getOpcodeSize(opcode: number): number {
    return getOpcodePayloadSize(opcode) + 1;
}

export function getCodeSize(instructions: Instruction[]): number {
    return instructions.reduce((a, op) => a + getInstructionSize(op), 0);
}

export function getInstructionSize(instruction: Instruction): number {
    if (instruction.opcode === OPCODES.DATA) {
        return (instruction.payload as Uint8Array).length;
    }
    return getOpcodeSize(instruction.opcode);
}

export function commitCode(
    instructions: Instruction[],
    commitStart: number,
    instructionsStart: number = 0,
    instructionsCount?: number,
): number {
    let commitOffset = commitStart;
    if (instructionsCount === undefined) {
        instructionsCount = Math.min(
            instructions.length,
            instructionsStart + instructions.length,
        );
    }
    for (let i = 0; i < instructionsCount; ++i) {
        const p = instructions[i + instructionsStart];
        const s = getInstructionSize(p);
        p.offset = commitOffset;
        commitOffset += s;
    }
    return commitOffset - commitStart;
}

export function serializeCode(
    buf: Buffer,
    instructions: Instruction[],
    instructionsStart: number = 0,
    instructionsCount?: number,
    commitOffset: number = 0,
): void {
    instructionsStart = instructionsStart || 0;
    if (instructionsCount === undefined) {
        instructionsCount = Math.min(
            instructions.length,
            instructionsStart + instructions.length,
        );
    }
    for (let i = 0; i < instructionsCount; ++i) {
        const p = instructions[i + instructionsStart];
        if (p.offset === undefined) {
            throw new Error(`Encountered uncommitted instruction`);
        }
        if (p.opcode === OPCODES.DATA) {
            (p.payload as Buffer).copy(buf, commitOffset + p.offset);
        } else {
            buf.writeUint8(p.opcode, commitOffset + p.offset);
            const payloadSize = getOpcodePayloadSize(p.opcode);
            if (p.payload && payloadSize != 0) {
                parsePayload(p.payload, payloadSize).copy(
                    buf,
                    commitOffset + p.offset + 1
                );
            }
        }
    }
}

// Map labels to jump offsets.
export function linkCodes(...codes: Instruction[][]): void {
    const labelMaps = {} as
        { [scope: string]: { [label: string]: number } };
    for (const instructions of codes) {
        for (const p of instructions) {
            if (typeof(p.offset) !== 'number') {
                throw new Error(`Encountered uncommitted opcode: ${p}`);
            }
            if (p.label) {
                const label = p.label;
                let scope = 'GLOBAL';
                if (!label.startsWith('::')) {
                    if (!p.scopeId) {
                        throw new Error(`Encountered local label ${label} outside of scope`);
                    }
                    scope = p.scopeId;
                }
                const scopedLabelMap = labelMaps[scope] = labelMaps[scope] || {};
                if (label in scopedLabelMap) {
                    throw new Error(`Label ${label} already exists in scope ${scope}`);
                }
                scopedLabelMap[label] = p.offset;
            }
        }
    }
    for (const instructions of codes) {
        for (const p of instructions) {
            if (isPushOpcode(p.opcode)) {
                if (
                    typeof(p.payload) === 'string' &&
                    p.payload && LABEL_REGEX.test(p.payload)
                ) {
                    const label = p.payload;
                    let scopedLabelMap;
                    if (label.startsWith('::')) {
                        scopedLabelMap = labelMaps['GLOBAL'];
                    } else {
                        if (!p.scopeId) {
                            throw new Error(`Encountered local label ${label} outside of scope`);
                        }
                        scopedLabelMap = labelMaps[p.scopeId];
                    }
                    if (!label || !(label in scopedLabelMap)) {
                        throw new Error(`label ${label} not found in scope`);
                    }
                    p.payload = scopedLabelMap[label];
                }
            }
        }
    }
}

function parsePayload(
    payload: string | number | Uint8Array,
    size: number,
): Buffer {
    if (payload === undefined) {
        throw new Error(`Encountered undefined payload: ${payload}`);
    }
    if (payload instanceof Uint8Array) {
        const buf = Buffer.alloc(size);
        buf.set(payload, size - buf.length);
        return buf;
    }
    return Buffer.from(toBytes(payload, { size }));
}

export function dupeCode(instructions: Instruction[]): Instruction[] {
    const scopeId = randomId();
    return instructions.map(op => ({ ...op, scopeId: scopeId }));
}