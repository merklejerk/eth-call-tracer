# Experimental `eth_call` Tracer
Debug RPC (`debug_traceCall`, `debug_traceTransaction`, etc) commands are heavy, slow, not always available on all EVM networks, and usually priced at a higher rate by commercial providers. What if we could trace a transactions with the much cheaper, faster, and generally available `eth_call` RPC command instead?

## How it Works
This is an exploratory WIP tech demo that takes arbitrary transaction params and attempts to trace its execution using `eth_call`. Normally, `eth_call` only returns the output data of a transaction's top-level function call. This project leverages geth's `eth_call` extensions (which are available on most commercial providers oh most EVM chains) to get granular trace-like data from the transaction!

Here's the steps we take:
1. Use `eth_createAccessList` to determine every address the transaction interact with.
2. Fetch the bytecode for each of those addresses.
3. Disassemble all the bytecode into EVM opcodes.
4. Patch said bytecode with EVM opcode fragments (we use a built-in, custom EVM ASM compiler) to inject debug hooks in place of operations we're interested in. Those hooks will run new code that stores a record of each operation.
4. Finally, we run the transaction with these bytecode overrides through a "runner" contract that returns all the stored debug events.

Yes, it's an extreme abuse of `eth_call`. 😅

## Does it Work?
Surprisingly this seems to correctly trace 90-95% of transactions in your average block at the moment.

This is a fairly naive implementation which first relies on `eth_createAccessList` and multiple `eth_getCode`s as preparation to the final `eth_call`. This adds signficant overhead but for moderate complexity transactions total responsiveness is still around 0.5s using Alchemy free tier. Production applications should take advantage of bytecode caching or can even choose to hook a predeterimined list of contracts. 

## What Can This Tech Enable?
- The hooks that track trace events are actually just solidity contracts. They can be changed to dynamically react to or alter the behavior of exection steps. E.g.:
	- Patch the result of any call during a simulation.
	- Dynamically change the value of a storage operation (SLOAD, SSTORE).
	- Inject and execute arbitrary on-chain logic after "something" happens.
- With some obvious optimizations this could also be an extremely fast and reliable tracer which can make for very responsive online debuggers. Users can also bring their own RPC provider since all RPC commands needed are generally available.
- MEV bots, keepers, or indexers looking that need fast, high volume tracing.

## What Works
- Capturing every type of external call (`CALL`, `CALLCODE`, `DELEGATECALL`, `STATICCALL`) and their result.
- Capturing events (`LOG0 - LOG4`).
- Capturing storage writes, old values and new values.
- Bytecode offset translation for `CODECOPY`, `CODESIZE`, `EXTCODECOPY`, `EXTCODESIZE`, and `EXTCODEHASH` when referencing self.
- Translation of program counter (`PC`).
- Translation of `tx.origin` (`ORIGIN`).

## What Doesn't Work (Yet)
- Patching of bytecode (init and runtime) for contracts deployed in the tx.
- Capturing SLOADs (ez though).
- Gas translation. I.e., deducting tracer overhead from `GAS` opcode.
- Respecting tx gas limit.
- More things that might be fun to capture/override (`SELFDESTRUCT`, `BALANCE`, `SELFBALANCE`, `CREATE/2`, etc).

## Installing & Building

```bash
$ forge install
$ npm i --dev
$ npm run build
```

## Command Line Options

```bash
$ npm start -- --help

Options:
      --help       Show help                                           [boolean]
      --version    Show version number                                 [boolean]
      --rpc-url    node RPC url                                         [string]
      --from       TX caller
                [string] [default: "0x0000000000000000000000000000000000000000"]
      --to         TX target
                [string] [default: "0x0000000000000000000000000000000000000000"]
      --value      TX value                                             [string]
      --block      block number
      --gas-price  gas price (gwei)                                     [number]
      --gas        gas                                                  [number]
      --data       TX data                              [string] [default: "0x"]
      --tx         historic TX hash                                     [string]
  -q, --quiet                                                          [boolean]
  -L, --logs-only                                                      [boolean]
```

## Sample Usage

Below is a sample command that traces an ETH -> USDT swap against the UniswapV3 router. Replace `$NODE_RPC` with your node's RPC URL.

```bash
$ npm start -- --rpc-url $NODE_RPC --from 0x00000000219ab540356cBB839Cbe05303d7705Fa --to 0x7a250d5630b4cf539739df2c5dacb4c659f2488d --value 1237730000000000000 --data 0x7ff36ab50000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000008000000000000000000000000049aa8f1e5668dc04723a3d98a516e742d33584d800000000000000000000000000000000000000000000000000000000f3d218840000000000000000000000000000000000000000000000000000000000000002000000000000000000000000c02aaa39b223fe8d0a0e5c4f27ead9083c756cc2000000000000000000000000dac17f958d2ee523a2206206994597c13d831ec7

{
  from: '0x00000000219ab540356cBB839Cbe05303d7705Fa',
  to: '0x7a250d5630b4cf539739df2c5dacb4c659f2488d',
  data: '0x7ff36ab50000000000000000000000000000000000000000000000000000000068e755a0000000000000000000000000000000000000000000000000000000000000008000000000000000000000000049aa8f1e5668dc04723a3d98a516e742d33584d800000000000000000000000000000000000000000000000000000000f3d218840000000000000000000000000000000000000000000000000000000000000002000000000000000000000000c02aaa39b223fe8d0a0e5c4f27ead9083c756cc2000000000000000000000000dac17f958d2ee523a2206206994597c13d831ec7',
  value: '1237730000000000000',
  gas: 1000000,
  gasPrice: 0,
  block: undefined
}
eth_call took 0.48 seconds
{
	"success": true,
	"returnData": "0x00000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000112d4ce091d820000000000000000000000000000000000000000000000000000000000076e6338d",
	"spy_calls": [
		{
			"index": "0",
			"context": "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D",
			"callType": "1",
			"to": "0x0d4a11d5EEaaC28EC3F61d100daF4d40471f1852",
			"value": "0",
			"gas": "28783034",
			"data": "0x0902f1ac",
			"result": "0x00000000000000000000000000000000000000000000024af5db49764da2619600000000000000000000000000000000000000000000000000000feba43cc3120000000000000000000000000000000000000000000000000000000063d2174b",
			"success": true,
			"gasUsed": "7063"
		},
		{
			"index": "1",
			"context": "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D",
			"callType": "0",
			"to": "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
			"value": "1237730000000000000",
			"gas": "28198850",
			"data": "0xd0e30db0",
			"result": "0x",
			"success": true,
			"gasUsed": "320492"
		},
		{
			"index": "4",
			"context": "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D",
			"callType": "0",
			"to": "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
			"value": "0",
			"gas": "27596264",
			"data": "0xa9059cbb0000000000000000000000000d4a11d5eeaac28ec3f61d100daf4d40471f1852000000000000000000000000000000000000000000000000112d4ce091d82000",
			"result": "0x0000000000000000000000000000000000000000000000000000000000000001",
			"success": true,
			"gasUsed": "396008"
		},
		{
			"index": "10",
			"context": "0x0d4a11d5EEaaC28EC3F61d100daF4d40471f1852",
			"callType": "0",
			"to": "0xdAC17F958D2ee523a2206206994597C13D831ec7",
			"value": "0",
			"gas": "25701389",
			"data": "0xa9059cbb00000000000000000000000049aa8f1e5668dc04723a3d98a516e742d33584d80000000000000000000000000000000000000000000000000000000076e6338d",
			"result": "0x",
			"success": true,
			"gasUsed": "574271"
		},
		{
			"index": "14",
			"context": "0x0d4a11d5EEaaC28EC3F61d100daF4d40471f1852",
			"callType": "1",
			"to": "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
			"value": "0",
			"gas": "24870640",
			"data": "0x70a082310000000000000000000000000d4a11d5eeaac28ec3f61d100daf4d40471f1852",
			"result": "0x00000000000000000000000000000000000000000000024b07089656df7a8196",
			"success": true,
			"gasUsed": "4262"
		},
		{
			"index": "15",
			"context": "0x0d4a11d5EEaaC28EC3F61d100daF4d40471f1852",
			"callType": "1",
			"to": "0xdAC17F958D2ee523a2206206994597C13D831ec7",
			"value": "0",
			"gas": "24606045",
			"data": "0x70a082310000000000000000000000000d4a11d5eeaac28ec3f61d100daf4d40471f1852",
			"result": "0x00000000000000000000000000000000000000000000000000000feb2d568f85",
			"success": true,
			"gasUsed": "22648"
		},
		{
			"index": "8",
			"context": "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D",
			"callType": "0",
			"to": "0x0d4a11d5EEaaC28EC3F61d100daF4d40471f1852",
			"value": "0",
			"gas": "26679473",
			"data": "0x022c0d9f00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000076e6338d00000000000000000000000049aa8f1e5668dc04723a3d98a516e742d33584d800000000000000000000000000000000000000000000000000000000000000800000000000000000000000000000000000000000000000000000000000000000",
			"result": "0x",
			"success": true,
			"gasUsed": "2539551"
		}
	],
	"spy_sloads": [],
	"spy_sstores": [
		{
			"index": "2",
			"context": "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
			"slot": "113575865250922862651991619052137407399521759499704957084106321734248371051432",
			"oldValue": "0x0000000000000000000000000000000000000000000000000000000000000000",
			"value": "0x000000000000000000000000000000000000000000000000112d4ce091d82000"
		},
		{
			"index": "5",
			"context": "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
			"slot": "113575865250922862651991619052137407399521759499704957084106321734248371051432",
			"oldValue": "0x000000000000000000000000000000000000000000000000112d4ce091d82000",
			"value": "0x0000000000000000000000000000000000000000000000000000000000000000"
		},
		{
			"index": "6",
			"context": "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
			"slot": "78217340955224583260704322316367930911365736621628114621345929384933888615440",
			"oldValue": "0x00000000000000000000000000000000000000000000024af5db49764da26196",
			"value": "0x00000000000000000000000000000000000000000000024b07089656df7a8196"
		},
		{
			"index": "9",
			"context": "0x0d4a11d5EEaaC28EC3F61d100daF4d40471f1852",
			"slot": "12",
			"oldValue": "0x0000000000000000000000000000000000000000000000000000000000000001",
			"value": "0x0000000000000000000000000000000000000000000000000000000000000000"
		},
		{
			"index": "11",
			"context": "0xdAC17F958D2ee523a2206206994597C13D831ec7",
			"slot": "31522459708058459104559660377019520587686043844720181043684373841271582389402",
			"oldValue": "0x00000000000000000000000000000000000000000000000000000feba43cc312",
			"value": "0x00000000000000000000000000000000000000000000000000000feb2d568f85"
		},
		{
			"index": "12",
			"context": "0xdAC17F958D2ee523a2206206994597C13D831ec7",
			"slot": "107240013827402204644041040165862560311170321074285555809409317722774507691462",
			"oldValue": "0x0000000000000000000000000000000000000000000000000000000198175ff9",
			"value": "0x000000000000000000000000000000000000000000000000000000020efd9386"
		},
		{
			"index": "16",
			"context": "0x0d4a11d5EEaaC28EC3F61d100daF4d40471f1852",
			"slot": "9",
			"oldValue": "0x0000000000000000000000000000000000002924ea509c1d5f303f0c0f9da95c",
			"value": "0x0000000000000000000000000000000000002924eaa3eefa0fbdc458bcbb2720"
		},
		{
			"index": "17",
			"context": "0x0d4a11d5EEaaC28EC3F61d100daF4d40471f1852",
			"slot": "10",
			"oldValue": "0x000000000000000000000142cbb0f8571b954384a7add4e228f87ccab5a97ecf",
			"value": "0x000000000000000000000142cbb2b2c26f8e5200614646707b04dadd738ed2a3"
		},
		{
			"index": "18",
			"context": "0x0d4a11d5EEaaC28EC3F61d100daF4d40471f1852",
			"slot": "8",
			"oldValue": "0x63d2174b00000000000000000feba43cc31200000000024af5db49764da26196",
			"value": "0x63d2175700000000000000000feb2d568f8500000000024b07089656df7a8196"
		},
		{
			"index": "21",
			"context": "0x0d4a11d5EEaaC28EC3F61d100daF4d40471f1852",
			"slot": "12",
			"oldValue": "0x0000000000000000000000000000000000000000000000000000000000000000",
			"value": "0x0000000000000000000000000000000000000000000000000000000000000001"
		}
	],
	"spy_logs": [
		{
			"index": "3",
			"context": "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
			"numTopics": "2",
			"topics": [
				"0xe1fffcc4923d04b559f4d29a8bfc6cda04eb5b0d3c460751c2402c5c5cc9109c",
				"0x0000000000000000000000007a250d5630b4cf539739df2c5dacb4c659f2488d",
				"0x0000000000000000000000000000000000000000000000000000000000000000",
				"0x0000000000000000000000000000000000000000000000000000000000000000"
			],
			"data": "0x000000000000000000000000000000000000000000000000112d4ce091d82000"
		},
		{
			"index": "7",
			"context": "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
			"numTopics": "3",
			"topics": [
				"0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
				"0x0000000000000000000000007a250d5630b4cf539739df2c5dacb4c659f2488d",
				"0x0000000000000000000000000d4a11d5eeaac28ec3f61d100daf4d40471f1852",
				"0x0000000000000000000000000000000000000000000000000000000000000000"
			],
			"data": "0x000000000000000000000000000000000000000000000000112d4ce091d82000"
		},
		{
			"index": "13",
			"context": "0xdAC17F958D2ee523a2206206994597C13D831ec7",
			"numTopics": "3",
			"topics": [
				"0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
				"0x0000000000000000000000000d4a11d5eeaac28ec3f61d100daf4d40471f1852",
				"0x00000000000000000000000049aa8f1e5668dc04723a3d98a516e742d33584d8",
				"0x0000000000000000000000000000000000000000000000000000000000000000"
			],
			"data": "0x0000000000000000000000000000000000000000000000000000000076e6338d"
		},
		{
			"index": "19",
			"context": "0x0d4a11d5EEaaC28EC3F61d100daF4d40471f1852",
			"numTopics": "1",
			"topics": [
				"0x1c411e9a96e071241c2f21f7726b17ae89e3cab4c78be50e062b03a9fffbbad1",
				"0x0000000000000000000000000000000000000000000000000000000000000000",
				"0x0000000000000000000000000000000000000000000000000000000000000000",
				"0x0000000000000000000000000000000000000000000000000000000000000000"
			],
			"data": "0x00000000000000000000000000000000000000000000024b07089656df7a819600000000000000000000000000000000000000000000000000000feb2d568f85"
		},
		{
			"index": "20",
			"context": "0x0d4a11d5EEaaC28EC3F61d100daF4d40471f1852",
			"numTopics": "3",
			"topics": [
				"0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822",
				"0x0000000000000000000000007a250d5630b4cf539739df2c5dacb4c659f2488d",
				"0x00000000000000000000000049aa8f1e5668dc04723a3d98a516e742d33584d8",
				"0x0000000000000000000000000000000000000000000000000000000000000000"
			],
			"data": "0x000000000000000000000000000000000000000000000000112d4ce091d82000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000076e6338d"
		}
	]
}
```