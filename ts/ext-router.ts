import { randomBytes } from "crypto";
import { Instruction, OPCODES } from "./evm-assembler";

export function createExtCodeSizeRouter(
    accountCodeSizes: { [addr: string]: number },
): Instruction[] {
    const code: Instruction[] = [
        {
            label: '::extcodesize-router',
            opcode: OPCODES.JUMPDEST,
        },
    ];
    for (const [addr, size] of Object.entries(accountCodeSizes)) {
        const skipLabel = `:__skip-${randomBytes(8).toString('hex')}`
        code.push(
            // addr, :jumpback
            // addr, addr, :jumpback
            { opcode: OPCODES.DUP1 },
            // addr', addr, addr, :jumpback
            { opcode: OPCODES.PUSH20, payload: addr },
            // addr'==addr, addr, :jumpback
            { opcode: OPCODES.EQ },
            // addr'!=addr, addr, :jumpback
            { opcode: OPCODES.ISZERO },
            // :skipLabel, addr'!=addr, addr, :jumpback
            { opcode: OPCODES.PUSH3, payload: skipLabel },
            // addr, :jumpback
            { opcode: OPCODES.JUMPI },
            // :jumpback
            { opcode: OPCODES.POP },
            // size, :jumpback
            { opcode: OPCODES.PUSH2, payload: size },
            // :jumpback, size
            { opcode: OPCODES.SWAP1 },
            // size
            { opcode: OPCODES.JUMP },
            // addr, :jumpback
            { opcode: OPCODES.JUMPDEST, label: skipLabel },
        );
    }
    // size, :jumpback
    code.push({ opcode: OPCODES.EXTCODESIZE });
    // :jumpback, size
    code.push({ opcode: OPCODES.SWAP1 });
    code.push({ opcode: OPCODES.JUMP });
    for (const o of code) {
        o.scopeId = '__EXTCODESIZE_ROUTER__';
    }
    return code;
}

export function createExtCodeHashRouter(
    accountCodeHashes: { [addr: string]: string },
): Instruction[] {
    const code: Instruction[] = [
        {
            label: '::extcodehash-router',
            opcode: OPCODES.JUMPDEST,
        },
    ];
    for (const [addr, hash] of Object.entries(accountCodeHashes)) {
        const skipLabel = `:__skip-${randomBytes(8).toString('hex')}`
        code.push(
            // addr, :jumpback
            // addr, addr, :jumpback
            { opcode: OPCODES.DUP1 },
            // addr', addr, addr, :jumpback
            { opcode: OPCODES.PUSH20, payload: addr },
            // addr'==addr, addr, :jumpback
            { opcode: OPCODES.EQ },
            // addr'!=addr, addr, :jumpback
            { opcode: OPCODES.ISZERO },
            // :skipLabel, addr'!=addr, addr, :jumpback
            { opcode: OPCODES.PUSH3, payload: skipLabel },
            // addr, :jumpback
            { opcode: OPCODES.JUMPI },
            // :jumpback
            { opcode: OPCODES.POP },
            // hash, :jumpback
            { opcode: OPCODES.PUSH32, payload: hash },
            // :jumpback, hash
            { opcode: OPCODES.SWAP1 },
            // hash
            { opcode: OPCODES.JUMP },
            // addr, :jumpback
            { opcode: OPCODES.JUMPDEST, label: skipLabel },
        );
    }
    // codeHash, :jumpback
    code.push({ opcode: OPCODES.EXTCODEHASH });
    // :jumpback, codeHash
    code.push({ opcode: OPCODES.SWAP1 });
    code.push({ opcode: OPCODES.JUMP });
    for (const o of code) {
        o.scopeId = '__EXTCODEHASH_ROUTER__';
    }
    return code;
}

export function createExtCodeCopyRouter(
    accountCodeOffsets: { [addr: string]: number },
): Instruction[] {
    const code: Instruction[] = [
        {
            label: '::extcodecopy-router',
            opcode: OPCODES.JUMPDEST,
        },
    ];
    for (const [addr, offset] of Object.entries(accountCodeOffsets)) {
        const skipLabel = `:__skip-${randomBytes(8).toString('hex')}`
        // TODO: handle OOB copies.
        code.push(
            // addr, dst, srcOffset, size, :jumpback
            // addr, addr, dst, srcOffset, size, :jumpback
            { opcode: OPCODES.DUP1 },
            // addr', addr, addr, dst, srcOffset, size, :jumpback
            { opcode: OPCODES.PUSH20, payload: addr },
            // addr'==addr, addr, dst, srcOffset, size, :jumpback
            { opcode: OPCODES.EQ },
            // addr'!=addr, addr, dst, srcOffset, size, :jumpback
            { opcode: OPCODES.ISZERO },
            // :skipLabel, addr'!=addr, addr, dst, srcOffset, size, :jumpback
            { opcode: OPCODES.PUSH3, payload: skipLabel },
            // addr, dst, srcOffset, size, :jumpback
            { opcode: OPCODES.JUMPI },
            // srcOffset, dst, addr, size, :jumpback
            { opcode: OPCODES.SWAP2 },
            // offset, srcOffset, dst, addr, size, :jumpback
            { opcode: OPCODES.PUSH3, payload: offset },
            // offset+srcOffset, dst, addr, size, :jumpback
            { opcode: OPCODES.ADD },
            // addr, dst, offset+srcOffset, size, :jumpback
            { opcode: OPCODES.SWAP2 },
            // :jumpback
            { opcode: OPCODES.EXTCODECOPY },
            { opcode: OPCODES.JUMP },
            // addr, dst, srcOffset, size, :jumpback
            { opcode: OPCODES.JUMPDEST, label: skipLabel },
        );
    }
    // :jumpback
    code.push({ opcode: OPCODES.EXTCODECOPY });
    code.push({ opcode: OPCODES.JUMP });
    for (const o of code) {
        o.scopeId = '__EXTCODECOPY_ROUTER__';
    }
    return code;
}