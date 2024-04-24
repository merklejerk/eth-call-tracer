import process from "process";
export async function timeItAsync<T>(promise: Promise<T>, label?: string): Promise<T> {
    const start = Date.now();
    const r = await promise;
    if (label) {
        console.info(label, `took`, ((Date.now() - start) / 1e3).toFixed(2), `seconds`);
    }
    return r;
}

const CUMULATIVE_TIMES = {} as { [id: string]: { totalTime: number; totalCalls: number } };

export async function timeItCumulative<T>(id: string, promise: Promise<T>): Promise<T> {
    const start = Date.now();
    const r = await promise;
    const c = CUMULATIVE_TIMES[id] = CUMULATIVE_TIMES[id] ?? { totalCalls: 0, totalTime: 0 };
    ++c.totalCalls;
    c.totalTime += (Date.now() - start);
    return r;
}

export function printCumulativeTimes(): void {
    console.info(Object.entries(CUMULATIVE_TIMES)
        .map(([id, { totalCalls, totalTime }]) =>
            `${id}: ${(totalTime / 1e3).toFixed(1)}s (${totalCalls} calls)`
        ).join('\n'),
    );
}

process.on('exit', () => {
    printCumulativeTimes();
});