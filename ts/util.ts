export async function timeItAsync<T>(promise: Promise<T>, label?: string): Promise<T> {
    const start = Date.now();
    const r = await promise;
    if (label) {
        console.info(label, `took`, ((Date.now() - start) / 1e3).toFixed(2), `seconds`);
    }
    return r;
}