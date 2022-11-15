import 'colors';
import dotenv from 'dotenv';
import { env as ENV } from 'process';
import process from 'process';
import FlexContract from 'flex-contract';
import FlexEther from 'flex-ether';
import { toHex } from 'flex-ether/src/util.js';
import yargs from 'yargs';

dotenv.config();

import RUNNER_ARTIFACT from '../out/Runner.sol/Runner.json';
import ORIGIN_ARTIFACT from '../out/Runner.sol/Origin.json';
import HOOKS_ARTIFACT from '../out/Runner.sol/SpyHooks.json';

import { patchBytecodeAsync, PatchOptions } from './patch';

const NULL_ADDRESS = '0x0000000000000000000000000000000000000000';
const NULL_BYTES = '0x';
const RUNNER_ADDRESS = '0x9000000000000000000000000000000000000001';
const HOOKS_ADDRESS = '0x9000000000000000000000000000000000000002';

yargs(process.argv.slice(2)).command('$0', 'run', yargs =>
    yargs
        .option('rpc-url', { type: 'string', desc: 'node RPC url' })
        .option('from', { type: 'string', desc: 'TX caller', default: NULL_ADDRESS })
        .option('to', { type: 'string', desc: 'TX target', default: NULL_ADDRESS })
        .option('value', { type: 'string', desc: 'TX value', default: '0' })
        .option('block', { type: 'number', desc: 'block number', default: 0 })
        .option('gas-price', { type: 'number', desc: 'gas price (gwei)', default: 0 })
        .option('gas', { type: 'number', desc: 'gas', default: 0 })
        .option('data', { type: 'string', desc: 'TX data', default: NULL_BYTES }),
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
    const gasPrice = argv.gasPrice ? (BigInt(argv.gasPrice) * BigInt(1e9)).toString() : 0;

    const r = await runner.run(
        {
            txOrigin: argv.from,
            txTo: argv.to,
            txValue: argv.value,
            txData: argv.data,
            txGas: 100e6,
            txGasPrice: gasPrice
        },
    ).call(
        {
            block: argv.block || undefined,
            overrides: {
                [argv.from]: { code: ORIGIN_ARTIFACT.deployedBytecode.object },
                [runner.address]: { code: RUNNER_ARTIFACT.deployedBytecode.object },
                [HOOKS_ADDRESS]: { code: HOOKS_ARTIFACT.deployedBytecode.object },
                ...(await getPatchedContractOverridesAsync(
                    eth,
                    {
                        from: argv.from,
                        to: argv.to,
                        value: argv.value,
                        gas: argv.gas,
                        gasPrice: gasPrice,
                        data: argv.data,
                        block: argv.block || undefined,
                    },
                    {
                        hooksAddress: HOOKS_ADDRESS,
                        origin: argv.from,
                    },
                )),
            },
        },
    );
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

async function getPatchedContractOverridesAsync(
    eth: FlexEther,
    txParams: TxParams,
    patchOpts: PatchOptions,
): Promise<{ [address: string]: { code: string } }> {
    let addresses = Object.keys(Object.assign(
        { [txParams.to]: true },
        ...(await getAccessListAsync(eth, txParams))
            .map(e => ({[e.address]: true })),
    ));
    let bytecodes: { [addr: string]: string } = Object.assign(
        {},
        ...(await Promise.all(addresses.map(a => eth.getCode(a))))
            .map((b, i) => ({ [addresses[i]]: b })),
    );
    bytecodes = Object.assign(
        {},
        ...Object
            .entries(bytecodes)
            .filter(([a, b]) => b !== '0x')
            .map(([a, b]) => ({ [a]: b })),
    );
    addresses = Object.keys(bytecodes);
    const r = Object.assign(
        {},
        ...(await Promise.all(
            Object
            .values(bytecodes)
            .map(bytecode => patchBytecodeAsync(bytecode, patchOpts)),
        )).map((b, i) => ({ [addresses[i]]: { code: b } })),
    );
    // console.log(r[txParams.to].code);
    return r;
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
            block: txParams.block || undefined, 
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