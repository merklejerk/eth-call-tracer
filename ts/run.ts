import 'colors';
import { env as ENV } from 'process';
import process from 'process';
import yargs from 'yargs';
import { Address, createPublicClient, Hex, http, keccak256, PublicClient, toHex, Transaction, TransactionReceipt, webSocket, zeroHash } from 'viem';

import * as RUNNER_ARTIFACT from '../out/Runner.sol/Runner.json';
import * as ORIGIN_ARTIFACT from '../out/Runner.sol/Origin.json';
import * as HOOKS_ARTIFACT from '../out/Runner.sol/SpyHooks.json';

import { patchBytecode, PatchOptions } from './patch';
import { timeItAsync, timeItCumulative } from './util';
import { mainnet } from 'viem/chains';

const NULL_ADDRESS = '0x0000000000000000000000000000000000000000';
const NULL_BYTES = '0x';
const EMPTY_HASH = keccak256('0x');
const RUNNER_ADDRESS = '0x9000000000000000000000000000000000000001' as Address;
const HOOKS_ADDRESS = '0x9000000000000000000000000000000000000002' as Address;

yargs(process.argv.slice(2)).command('$0', 'run', yargs =>
    yargs
        .option('rpc-url', { type: 'string', desc: 'node RPC url' })
        .option('from', { type: 'string', desc: 'TX caller', default: NULL_ADDRESS })
        .option('to', { type: 'string', desc: 'TX target', default: NULL_ADDRESS })
        .option('value', { type: 'number', desc: 'TX value', coerce: x => BigInt(x) })
        .option('block', { type: 'string', desc: 'block number', coerce: x => /^\d+$/.test(x) ? Number(x) : x })
        .option('gas-price', { type: 'number', desc: 'gas price (gwei)', coerce: x => BigInt(x) })
        .option('gas', { type: 'number', desc: 'gas' })
        .option('data', { type: 'string', desc: 'TX data', default: NULL_BYTES })
        .option('tx', { type: 'string', desc: 'historic TX hash' })
        .option('quiet', { type: 'boolean', alias: 'q' })
        .option('logs-only', { type: 'boolean', alias: 'L' }),
    argv => run(argv),
).parse();

async function run(argv): Promise<void> {
    const rpcUrl = argv.rpcUrl || ENV.NODE_RPC;
    if (!rpcUrl) {
        throw new Error(`no RPC URL set!`);
    }
    const transport = /^wss?:\/\//.test(rpcUrl) ? webSocket(rpcUrl) : http(rpcUrl);
    const client = (createPublicClient as any)({ transport, chain: mainnet }) as PublicClient;
    let tx: TxParams;
    if (argv.tx) {
        const tx_ = await client.getTransaction({ hash: argv.tx });
        tx = {
            from: tx_.from,
            to: tx_.to,
            data: tx_.input,
            value: argv.value !== undefined ? argv.value : tx_.value,
            gas: argv.gas !== undefined ? argv.gas : tx_.gas,
            gasPrice: argv.gasPrice !== undefined
                ? BigInt(argv.gasPrice) * BigInt(1e9)
                : tx_.gasPrice,
            block: argv.block !== undefined
                ? argv.block
                : Number(tx_.blockNumber) - 1,
        };
    } else {
        tx = {
            from: argv.from,
            to: argv.to,
            data: argv.data,
            value: argv.value || 0,
            gas: argv.gas || 1e6,
            gasPrice: argv.gasPrice || 0,
            block: typeof(argv.block) === 'string' ? undefined : argv.block,
        };
    }
    if (!argv.quiet) {
        console.debug(tx);
    }
    const r = await timeItAsync(buildTrace({ client, tx }), 'buildTrace()');
    console.log(r);
    process.exit();
    // console.log(JSON.stringify(cleanResultObject(r), null, '\t'));
}

interface TxParams {
    from: Address;
    to: Address;
    value: bigint;
    data: Hex;
    gas: number;
    gasPrice: bigint;
    block?: number;
}

async function getInitialTransactionAccounts(
    client: PublicClient,
    txParams: TxParams,
): Promise<Address[]> {
    return Object.keys(Object.assign(
        { [txParams.to.toLowerCase()]: true },
        ...(await getAccessListAsync(client, txParams))
            .map(e => ({[e.address.toLowerCase()]: true })),
    )) as Address[];
}

async function getBytecodes(
    client: PublicClient,
    addresses: Address[],
): Promise<{ [address: Address]: Hex }> {
    return Object.assign({},
        ...await Promise.all(addresses.map(async address => {
            return { [address]: await client.getBytecode({ address }) };
        })),
    );
}

async function getAccessListAsync(client: PublicClient, txParams: TxParams)
    : Promise<Array<{ address: string }>>
{
    try {
        const {accessList} = await client.transport.request({
            method: 'eth_createAccessList',
            params: [
                {
                    to: txParams.to,
                    from: txParams.from,
                    gas: toHex(txParams.gas),
                    gasPrice: toHex(txParams.gasPrice),
                    value: toHex(txParams.value),
                    data: txParams.data,
                },
                ...(txParams.block ? [toHex(txParams.block)] : []),
            ]
        }) as { accessList: Array<{ address: string }> };
        return accessList;
    } catch (err) {
        if (err?.details !== 'Method not found') {
            throw err;
        }
    }
    return [];
}

function cleanResultObject(o: any): any {
    if (Array.isArray(o)) {
        return o.map(v => cleanResultObject(v));
    } else if (typeof(o) === 'object') {
        return Object.assign({}, ...Object.entries(o).map(([k, v]) => {
            if (!/^\d+$/.test(k)) {
                return { [k]: cleanResultObject(v) };
            }
            return {};
        }));
    }
    return o;
}

enum CallType {
    Call = 0,
    Static = 1,
    Delegate = 2,
    Code = 3,
}

interface RunResult {
    succesS: boolean;
    returnData: Hex;
    spy_calls: Array<{
        index: bigint;
        context: Address;
        callType: CallType;
        to: Address;
        value: bigint;
        gas: bigint;
        data: Hex;
        result: Hex;
        success: boolean;
        gasUsed: bigint;
    }>;
    spy_logs: Array<{
        index: bigint;
        context: Address;
        numTopics: number;
        topics: Hex[];
        data: Hex;
    }>;
}
async function buildTrace(opts: {
    client: PublicClient;
    tx: TxParams;
    maxIterations?: number;
}): Promise<RunResult> {
    const { client, tx } = opts;
    const maxIterations = opts.maxIterations ?? 100;
    const toCachedCode = (original: Hex, patched: Hex) => ({
        original,
        patched,
        originalHash: keccak256(original),
        patchedHash: keccak256(patched),
    });
    const codeByAddress = {
        [tx.from.toLowerCase()]: toCachedCode('0x', ORIGIN_ARTIFACT.deployedBytecode.object as Hex),
        [RUNNER_ADDRESS]: toCachedCode('0x', RUNNER_ARTIFACT.deployedBytecode.object as Hex),
        [HOOKS_ADDRESS]: toCachedCode('0x', HOOKS_ARTIFACT.deployedBytecode.object as Hex),
    };
    let unknowns = await getInitialTransactionAccounts(client, tx);
    let r: RunResult | null = null;
    let round = 0;
    for (; round < maxIterations; ++round) {
        Object.assign(
            codeByAddress,
            ...Object.entries(await timeItCumulative('getBytecodes', getBytecodes(client, unknowns)))
                .map(([address, code]) => ({
                    [address.toLowerCase()]: toCachedCode(code, '0x')
                })),
        );
        const patchOpts: PatchOptions = {
            hooksAddress: HOOKS_ADDRESS,
            origin: tx.from,
            originalStates: Object.assign(
                {},
                ...Object.entries(codeByAddress)
                    .map(([ addr, { original, originalHash } ]) => ({
                        [addr]: { code: original, codeHash: originalHash },
                    })),
            ),
        }
        for (const addr of unknowns) {
            codeByAddress[addr].patched = patchBytecode(codeByAddress[addr].original, patchOpts);
            codeByAddress[addr].patchedHash = keccak256(codeByAddress[addr].patched);
        }
        r = await timeItCumulative('readContract', client.readContract({
            abi: RUNNER_ARTIFACT.abi,
            address: RUNNER_ADDRESS,
            functionName: 'run',
            account: tx.from,
            ...(typeof(tx.block) === 'string'
                ? ({ blockTag: tx.block })
                : ({ blockNumber: BigInt(tx.block) })
            ),
            args: [
                {
                    txOrigin: tx.from,
                    txTo: tx.to,
                    txValue: tx.value,
                    txData: tx.data,
                    txGas: 100e6,
                    txGasPrice: tx.gasPrice,
                },
            ],
            stateOverride: Object.entries(codeByAddress).map(([addr, codes]) => ({
                address: addr as Address,
                code: codes.patched,
            })),
        })) as RunResult;
        unknowns = [];
        for (const c of r.spy_calls) {
            const to = c.to.toLowerCase() as Address;
            if (!(to in codeByAddress)
                && c.callType !== CallType.Static
                && c.success)
            {
                unknowns.push(to);
            }
        }
        if (unknowns.length === 0) {
            break;
        }
    }
    console.debug(`Found all overrides after ${round+1} rounds!`);
    return r;
}