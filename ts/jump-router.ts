import { Instruction, OPCODES } from "./evm-compiler";

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
        code.push(
            // jumpdest, jumpdest
            { opcode: OPCODES.DUP1 },
            // from, jumpdest, jumpdest
            { opcode: OPCODES.PUSH3, payload: Number(from) },
            // from == jumpdest, jumpdest
            { opcode: OPCODES.EQ },
            // to, from == jumpdest, jumpdest
            { opcode: OPCODES.PUSH3, payload: to },
            // jumpdest (jumpdest will pop)
            { opcode: OPCODES.JUMPI },
        );
    }
    code.push({ opcode: OPCODES.JUMP });
    return code;
}