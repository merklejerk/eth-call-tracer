import { randomBytes } from "crypto";
import { Instruction, OPCODES } from "./evm-assembler";

export function createJumpRouterCode(
    instructions: Instruction[],
): Instruction[] {
    const remaps = {} as { [from: number]: number | string };
    for (const op of instructions) {
        if (op.opcode === OPCODES.JUMPDEST) {
            if (typeof(op.originalOffset) === 'number') {
                let to;
                if (op.offset === undefined) {
                    if (!op.label) {
                        throw new Error(
                            `Encountered JUMPDEST with empty label` +
                            ` at ${op.originalOffset} when trying to` +
                            ` create jump router!`
                        );
                    }
                    to = op.label;
                } else {
                    to = op.offset;
                }
                remaps[op.originalOffset] = to;
            }
        }
    }
    const code: Instruction[] = [
        {
            label: '::jump-router',
            opcode: OPCODES.JUMPDEST,
        },
    ];
    for (const [from, to] of Object.entries(remaps)) {
        const skipLabel = `:__skip-${randomBytes(8).toString('hex')}`
        code.push(
            // jumpdest, jumpdest
            { opcode: OPCODES.DUP1 },
            // from, jumpdest, jumpdest
            { opcode: OPCODES.PUSH3, payload: Number(from) },
            // from == jumpdest, jumpdest
            { opcode: OPCODES.EQ },
            // from != jumpdest, jumpdest
            { opcode: OPCODES.ISZERO },
            // :skipLabel, from != jumpdest, jumpdest
            { opcode: OPCODES.PUSH3, payload: skipLabel },
            // jumpdest
            { opcode: OPCODES.JUMPI },
            { opcode: OPCODES.POP },
            // to
            { opcode: OPCODES.PUSH3, payload: to },
            { opcode: OPCODES.JUMP },
            // jumpdest
            { opcode: OPCODES.JUMPDEST, label: skipLabel }
        );
    }
    code.push({ opcode: OPCODES.INVALID });
    for (const o of code) {
        o.scopeId = '__JUMP_ROUTER__';
    }
    return code;
}