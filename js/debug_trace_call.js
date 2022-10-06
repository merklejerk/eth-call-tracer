'use strict'
require('colors');
require('dotenv').config();
const { env: ENV } = require('process');
const FlexContract = require('flex-contract');
const FlexEther = require('flex-ether');

const NULL_ADDRESS = '0x0000000000000000000000000000000000000000';
const NULL_BYTES = '0x';

require('yargs').command('$0', 'run', yargs =>
    yargs
        .option('rpc-url', { type: 'string', desc: 'node RPC url' })
        .option('from', { type: 'string', desc: 'TX caller', default: NULL_ADDRESS })
        .option('to', { type: 'string', desc: 'TX target', default: NULL_ADDRESS })
        .option('value', { type: 'string', desc: 'TX value', default: 0 })
        .option('block', { type: 'number', desc: 'block number', default: 0 })
        .option('gas-price', { type: 'number', desc: 'gas price (gwei)', default: 0 })
        .option('data', { type: 'string', desc: 'TX data', default: NULL_BYTES }),
    argv => run(argv),
).argv;


async function run(argv) {
    const rpcUrl = argv.rpcUrl || ENV.NODE_RPC;
    if (!rpcUrl) {
        throw new Error(`no RPC URL set!`);
    }
    const eth = new FlexEther({ providerURI: rpcUrl });
    const block = argv.block || await eth.getBlockNumber();
    const r = await eth.rpc._send(
        'debug_traceCall',
        [
            {
                from: argv.from,
                to: argv.to,
                value: FlexEther.util.toHex(argv.value),
                data: argv.data,
                gasPrice: FlexEther.util.toHex(argv.gasPrice * 1e9),
            },
            FlexEther.util.toHex(block),
            {
                tracer: 'callTracer',
            },
        ],
    );
    console.log(r);
}
