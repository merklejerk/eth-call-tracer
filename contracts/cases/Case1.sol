// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

contract Case1 {
    bytes32 immutable foo;

    constructor() {
        foo = bytes32(type(uint256).max);
    }

    function doTheFoo() external view returns (bytes32) {
        return foo;
    }

    function doTheDoo() external view returns (bytes memory) {
        return hex"ffddee33da019412aaabbbbb908f8a900090eeee909909091233aaaa";
    }
}


