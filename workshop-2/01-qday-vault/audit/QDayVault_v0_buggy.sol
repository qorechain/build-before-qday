// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

// FIRST DRAFT, for the audit demo (stage 1). Do not deploy.
interface IQorePQC {
    function pqcVerify(bytes calldata pubkey, bytes calldata signature, bytes calldata message)
        external view returns (bool valid);
    function pqcKeyStatus(address account)
        external view returns (bool registered, uint8 algorithmId, bytes memory pubkey, bool possessionProven);
}

contract QDayVault {
    IQorePQC internal constant PQC_VERIFY = IQorePQC(0x0000000000000000000000000000000000000a01);
    IQorePQC internal constant PQC_KEYS = IQorePQC(0x0000000000000000000000000000000000000a02);

    address public guardian;

    constructor(address guardian_) payable {
        guardian = guardian_;
    }

    receive() external payable {}

    function setGuardian(address g) external {
        guardian = g;
    }

    function withdraw(address payable to, uint256 amount, bytes calldata mldsaSignature) external {
        (, , bytes memory pubkey, ) = PQC_KEYS.pqcKeyStatus(guardian);
        bytes memory message = abi.encodePacked(to, amount);
        require(PQC_VERIFY.pqcVerify(pubkey, mldsaSignature, message), "bad signature");
        to.call{value: amount}("");
    }
}
