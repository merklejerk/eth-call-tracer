import 'colors';
import * as ethjs from 'ethereumjs-util';
import dotenv from 'dotenv';
import { env as ENV, openStdin } from 'process';
import process from 'process';
import FlexContract from 'flex-contract';
import FlexEther from 'flex-ether';
import { toHex } from 'flex-ether/src/util.js';
import yargs from 'yargs';

dotenv.config();

import RUNNER_ARTIFACT from '../out/Runner.sol/Runner.json';
import ORIGIN_ARTIFACT from '../out/Runner.sol/Origin.json';
import HOOKS_ARTIFACT from '../out/Runner.sol/SpyHooks.json';

import { patchBytecode, PatchOptions } from './patch';
import { timeItAsync } from './util';

const NULL_ADDRESS = '0x0000000000000000000000000000000000000000';
const NULL_BYTES = '0x';
const EMPTY_HASH = ethjs.bufferToHex(ethjs.keccak256(Buffer.alloc(0)));
const RUNNER_ADDRESS = '0x9000000000000000000000000000000000000001';
const HOOKS_ADDRESS = '0x9000000000000000000000000000000000000002';

yargs(process.argv.slice(2)).command('$0', 'run', yargs =>
    yargs
        .option('rpc-url', { type: 'string', desc: 'node RPC url' })
        .option('from', { type: 'string', desc: 'TX caller', default: NULL_ADDRESS })
        .option('to', { type: 'string', desc: 'TX target', default: NULL_ADDRESS })
        .option('value', { type: 'string', desc: 'TX value' })
        .option('block', { type: ['number', 'string'], desc: 'block number' })
        .option('gas-price', { type: 'number', desc: 'gas price (gwei)' })
        .option('gas', { type: 'number', desc: 'gas' })
        .option('data', { type: 'string', desc: 'TX data', default: NULL_BYTES })
        .option('tx', { type: 'string', desc: 'historic TX hash' })
        .option('quiet', { type: 'boolean', alias: 'q' })
        .option('logs-only', { type: 'boolean', alias: 'L' }),
    argv => run(argv),
).argv;

async function run(argv): Promise<void> {
    const rpcUrl = argv.rpcUrl || ENV.NODE_RPC;
    if (!rpcUrl) {
        throw new Error(`no RPC URL set!`);
    }
    const eth = new FlexEther({ providerURI: rpcUrl });
    const runner = new FlexContract(
        RUNNER_ARTIFACT.abi,
        RUNNER_ADDRESS,
        { eth },
    );
    let tx: TxParams;
    if (argv.tx) {
        const tx_ = await eth.getTransaction(argv.tx);
        const receipt = await eth.getTransactionReceipt(argv.tx);
        tx = {
            from: tx_.from,
            to: tx_.to,
            data: tx_.input,
            value: argv.value !== undefined ? argv.value : tx_.value,
            gas: argv.gas !== undefined ? argv.gas : tx_.gas,
            gasPrice: argv.gasPrice !== undefined
                ? (BigInt(argv.gasPrice) * BigInt(1e9)).toString()
                : tx_.gasPrice,
            block: argv.block !== undefined
                ? (typeof(argv.block) === 'string' ? undefined : argv.block)
                : receipt.blockNumber - 1,
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
    const accounts = await getTransactionAccounts(eth, tx);
    const r = await timeItAsync(runner.run(
        {
            txOrigin: tx.from,
            txTo: tx.to,
            txValue: tx.value,
            txData: tx.data,
            txGas: 100e6,
            txGasPrice: tx.gasPrice,
        },
    ).call(
        {
            block: tx.block,
            overrides: {
                [tx.from]: { code: ORIGIN_ARTIFACT.deployedBytecode.object },
                [runner.address]: { code: RUNNER_ARTIFACT.deployedBytecode.object },
                [HOOKS_ADDRESS]: { code: HOOKS_ARTIFACT.deployedBytecode.object },
                ...getPatchedContractOverrides(
                    accounts,
                    {
                        hooksAddress: HOOKS_ADDRESS,
                        origin: tx.from,
                        logsOnly: argv.logsOnly,
                        originalStates: Object.assign(
                            {},
                            ...Object.keys(accounts).map(([a, c]) => ({
                                [a]: {
                                    code: c,
                                    codeHash: ethjs.bufferToHex(ethjs.keccak256(c)),
                                },
                            })),
                            {
                                [tx.from.toLowerCase()]: { code: NULL_BYTES, codeHash: EMPTY_HASH },
                                [runner.address.toLowerCase()]: { code: NULL_BYTES, codeHash: EMPTY_HASH },
                                [HOOKS_ADDRESS.toLowerCase()]: { code: NULL_BYTES, codeHash: EMPTY_HASH },
                            },
                        ),
                    },
                ),
            },
        },
    ), 'eth_call');
    console.log(JSON.stringify(cleanResultObject(r), null, '\t'));
}

interface TxParams {
    from: string;
    to: string;
    value: string | number;
    data: string;
    gas: number;
    gasPrice: string | number;
    block?: number;
}

async function getTransactionAccounts(
    eth: FlexEther,
    txParams: TxParams,
): Promise<{ [address: string]: string }> {
    let addresses = Object.keys(Object.assign(
        { [txParams.to.toLowerCase()]: true },
        ...(await getAccessListAsync(eth, txParams))
            .map(e => ({[e.address.toLowerCase()]: true })),
    ));
    let bytecodes: { [addr: string]: string } = Object.assign(
        {},
        ...(await Promise.all(addresses.map(a => eth.getCode(a))))
            .map((b, i) => ({ [addresses[i]]: b })),
    );
    return Object.assign(
        {},
        ...Object
            .entries(bytecodes)
            .filter(([a, b]) => b !== '0x')
            .map(([a, b]) => ({ [a]: b })),
    );
}

function getPatchedContractOverrides(
    accounts: { [address: string]: string },
    patchOpts: PatchOptions,
): { [address: string]: { code: string } } {
    return Object.assign(
        {},
        ...Object.entries(accounts).map(
            ([a, c]) => ({ [a]: { code: patchBytecode(c, patchOpts) } }),
        ),
    );
}

async function getAccessListAsync(eth: FlexEther, txParams: TxParams)
    : Promise<Array<{ address: string }>>
{
    const r = await eth.rpc._send('eth_createAccessList', [
        {
            to: txParams.to,
            from: txParams.from,
            gas: toHex(txParams.gas),
            gasPrice: toHex(txParams.gasPrice),
            value: toHex(txParams.value),
            data: txParams.data,
        },
        ...(txParams.block ? [toHex(txParams.block)] : []),
    ]);
    return r.accessList;
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