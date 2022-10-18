import { bgBlue } from 'colors';
import crypto from 'crypto';

const VALID_PUSH_COMMANDS = Object.assign(
    {},
    // PUSH1-PUSH32
    ...(() => [...new Array(32)].map((v, i) => ({[`PUSH${i + 1}`] : true })))(),
);

export const OPCODES = {
    CALL: 0xF1,
    CALLCODE: 0xF2,
    DELEGATECALL: 0xF4,
    STATICCALL: 0xFA,
    PUSH1: 0x60,
    PUSH2: 0x61,
    PUSH3: 0x62,
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
    SHR: 0x1C,
    ADD: 0x01,
    MUL: 0x02,
    SUB: 0x03,
    DIV: 0x04,
    MLOAD: 0x51,
    MSTORE: 0x52,
    MSTORE8: 0x53,
    AND: 0x16,
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
}

export interface Instruction {
    opcode: number;
    payload?: Buffer | string;
    label?: string;
    offset?: number;
    scopeId: string;
}

export function parseAsm(asm, env={}): Instruction[] {
    const instructions = [] as Instruction[];
    const scopeId = randomId();
    let nextLabel: string | null = null;
    for (const line of asm.split(/\r?\n/)) {
        const words = line.exec(/^(.*)(\/\/.+)?$/)?.[1]
            .split(/\s+/)
            .map(word => word.trim())
            .filter(word => word && word.length)
        if (!words) {
            continue;
        }
        if (/^::?\w+/.test(words[1])) {
            nextLabel = words[1];
            continue;
        }
        const op = words[1].toUpperCase();
        if (!(op in OPCODES)) {
            throw new Error(`Unknown EVM instruction: ${op}`);
        }
        if (op in VALID_PUSH_COMMANDS) {
            const r = /^PUSH(\d+)$/.exec(words[0]);
            if (!r) {
                throw new Error(`Invalid PUSH command: ${op}`);
            }
            const size = getOpcodePayloadSize(op);
            if (!/^(\d+|0x[a-f0-9]{2,64}|::?\w+|$\w+)$/i.test(words[2])) {
                throw new Error(`Invalid PUSH param: ${words[2]}`);
            }
            const rawPayload = words[2].startsWith('$')
                ? env[words[2].slice(1)]
                : words[2];
            if (rawPayload === 'undefined') {
                throw new Error(`Missing asm reference: ${words[2]}`);
            }
            instructions.push({
                opcode: OPCODES[op],
                payload: parsePayload(rawPayload, size),
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

function randomId(): string {
    return crypto.randomBytes(16).toString('hex');
}

export function parseBytecode(bytecode: number[] | Buffer): Instruction[] {
    const instructions = [] as Instruction[];
    let currentScopeId = randomId();
    for (let i = 0; i < bytecode.length; ++i) {
        const op = bytecode[i];
        switch (op) {
            case OPCODES.JUMPDEST:
                currentScopeId = randomId();
                instructions.push({
                   opcode: op,
                   scopeId: currentScopeId,
                   offset: i,
                });
                break;
            // TODO: check for unregistered opcodes and close block.
            //       Maybe also JUMPs?
            case OPCODES.INVALID:
            case OPCODES.SELFDESTRUCT:
            case OPCODES.STOP:
            case OPCODES.REVERT:
            case OPCODES.RETURN:
                if (currentScopeId) {
                    instructions.push({
                        opcode: op,
                        scopeId: currentScopeId,
                        offset: i,
                    });
                } 
                break;
            default:
                if (currentScopeId) {
                    const n = getOpcodeSize(op);
                    const instruction: Instruction = {
                        opcode: op,
                        scopeId: currentScopeId,
                        offset: i,
                    };
                    if (n > 0) {
                        const end = Math.min(bytecode.length, i + n + 1);
                        instruction.payload = parsePayload(bytecode.slice(i + 1, end), n - 1);
                    }
                    i += n;
                    instructions.push(instruction);
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
        return getOpcodePayloadSize(opcode);
    }
    return 0;
}

export function getOpcodeSize(opcode: number): number {
    return getOpcodePayloadSize(opcode) + 1;
}

export function commitInstructions(
    instructions: Instruction[],
    instructionsStart: number,
    instructionsCount: number,
    commitStart: number,
): void {
    let commitOffset = commitStart;
    for (let i = 0; i < instructionsCount; ++i) {
        const p = instructions[i + instructionsStart];
        const s = getOpcodeSize(p.opcode);
        p.offset = commitOffset;
        commitOffset += s;
    }
}

export function serializeInstructions(
    instructions: Instruction[],
    buf: Buffer,
    instructionsStart?: number,
    instructionsCount?: number,
    bufStart?: number
): void {
    bufStart = bufStart || 0;
    instructionsStart = instructionsStart || 0;
    instructionsCount = instructionsCount || instructions.length;
    for (let i = 0; i < instructionsCount; ++i) {
        const p = instructions[i + instructionsStart];
        if (p.offset === undefined) {
            throw new Error(`Encountered uncommitted instruction`);
        }
        const s = getOpcodeSize(p.opcode);
        buf.writeInt8(p.opcode);
        if (getOpcodePayloadSize(p.opcode) != 0) {
            if (!Buffer.isBuffer(p.payload)) {
                throw new Error(`Trying to serialize opcode with invalid payload`);
            }
            p.payload.copy(buf, bufStart + p.offset);
        }
    }
}

export function linkInstructions(instructions: Instruction[]): void {
    const labelMaps = { ['GLOBAL']: {} } as
        { [scope: string]: { [label: string]: number } };
    for (const p of instructions) {
        if (typeof(p.offset) !== 'number') {
            throw new Error(`Encountered uncommitted opcode: ${p}`);
        }
        if (p.label) {
            const label = p.label;
            const scopedLabelMap = label.startsWith('::')
                ? labelMaps['GLOBAL']
                : labelMaps[p.scopeId];
            if (label in scopedLabelMap) {
                throw new Error(`Label ${label} already exists`);
            }
            scopedLabelMap[label] = p.offset;
        }
    }
    for (const p of instructions) {
        if (isPushOpcode(p.opcode)) {
            if (
                typeof(p.payload) === 'string' &&
                p.payload && /^::?\w+$/.test(p.payload)
            ) {
                const label = p.payload;
                const scopedLabelMap = label.startsWith('::')
                    ? labelMaps['GLOBAL'] : labelMaps[p.scopeId];
                if (!label || !(label in scopedLabelMap)) {
                    throw new Error(`label ${label} not found in scope`);
                }
                p.payload = parsePayload(
                    scopedLabelMap[label],
                    getOpcodePayloadSize(p.opcode),
                );
            }
        }
    }
}

function parsePayload(
    payload: string | number | number[] | Buffer,
    size: number,
): Buffer {
    if (payload === undefined) {
        throw new Error(`Encountered undefined payload: ${payload}`);
    }
    if (Buffer.isBuffer(payload)) {
        const buf = Buffer.alloc(size);
        payload.copy(buf);
        return buf;
    }
    if (typeof(payload) === 'number' || typeof(payload) === 'string') {
        return Buffer.from(BigInt(payload).toString(16), 'hex');
    }
    const buf = Buffer.alloc(size);
    for (const i = 0; i < payload.length; ++i) {
        buf.writeInt8(payload[i], i);
    }
    return buf;
}