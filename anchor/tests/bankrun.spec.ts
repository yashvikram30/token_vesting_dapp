import { Keypair, PublicKey, SystemProgram, Transaction } from '@solana/web3.js'
import { ProgramTestContext, startAnchor, BanksClient, Clock } from 'solana-bankrun'
import * as anchor from '@coral-xyz/anchor'
import IDL from '../target/idl/vesting.json'
import { SYSTEM_PROGRAM_ID } from '@coral-xyz/anchor/dist/cjs/native/system'
import { BankrunProvider } from 'anchor-bankrun'
import { Vesting } from 'anchor/target/types/vesting'
import NodeWallet from '@coral-xyz/anchor/dist/cjs/nodewallet'
import {
  TOKEN_PROGRAM_ID,
  createInitializeMintInstruction,
  getMintLen,
  createMintToInstruction,
} from '@solana/spl-token'
import { BN } from '@coral-xyz/anchor'
import { resolve } from 'dns'

describe('Vesting Smart Contract Tests', () => {
  const companyName = 'Company'
  let beneficiary: Keypair
  let context: ProgramTestContext
  let provider: BankrunProvider
  let program: anchor.Program<Vesting>
  let banksClient: BanksClient
  let employer: Keypair
  let mint: PublicKey
  let beneficiaryProvider: BankrunProvider
  let program2: anchor.Program<Vesting>
  let vestingAccountKey: PublicKey
  let treasuryTokenAccount: PublicKey
  let employeeAccount: PublicKey

  beforeAll(async () => {
    beneficiary = new anchor.web3.Keypair()

    context = await startAnchor(
      '',
      [{ name: 'vesting', programId: new PublicKey(IDL.address) }],
      [
        {
          address: beneficiary.publicKey,
          info: {
            lamports: 1_000_000_000,
            data: Buffer.alloc(0),
            owner: SYSTEM_PROGRAM_ID,
            executable: false,
          },
        },
      ],
    )

    provider = new BankrunProvider(context)
    anchor.setProvider(provider)
    program = new anchor.Program<Vesting>(IDL as Vesting, provider)

    banksClient = context.banksClient
    employer = provider.wallet.payer

    // Create mint manually for bankrun compatibility
    const mintKeypair = Keypair.generate()
    mint = mintKeypair.publicKey

    const mintLen = getMintLen([])
    const lamports = 1_461_600 // Standard rent for mint account

    const createMintTx = new Transaction().add(
      SystemProgram.createAccount({
        fromPubkey: employer.publicKey,
        newAccountPubkey: mint,
        space: mintLen,
        lamports,
        programId: TOKEN_PROGRAM_ID,
      }),
      createInitializeMintInstruction(
        mint,
        2, // decimals
        employer.publicKey, // mint authority
        null, // freeze authority
        TOKEN_PROGRAM_ID,
      ),
    )

    createMintTx.recentBlockhash = context.lastBlockhash
    createMintTx.sign(employer, mintKeypair)

    await banksClient.processTransaction(createMintTx)

    beneficiaryProvider = new BankrunProvider(context)
    beneficiaryProvider.wallet = new NodeWallet(beneficiary)

    program2 = new anchor.Program<Vesting>(IDL as Vesting, beneficiaryProvider)
    ;[vestingAccountKey] = PublicKey.findProgramAddressSync([Buffer.from(companyName)], program.programId)
    ;[treasuryTokenAccount] = PublicKey.findProgramAddressSync(
      [Buffer.from('vesting_treasury'), Buffer.from(companyName)],
      program.programId,
    )
    ;[employeeAccount] = PublicKey.findProgramAddressSync(
      [Buffer.from('employee_vesting'), beneficiary.publicKey.toBuffer(), vestingAccountKey.toBuffer()],
      program.programId,
    )
  })

  it('This should create a vesting account', async () => {
    const tx = await program.methods
      .createVestingAccount(companyName)
      .accounts({
        signer: employer.publicKey,
        mint,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc({ commitment: 'confirmed' })

    const vestingAccountData = await program.account.vestingAccount.fetch(vestingAccountKey, 'confirmed')

    console.log('Vesting account data: ', vestingAccountData)
    console.log('Create vesting account: ', tx)
  })

  it('This should fund the treasury token account', async () => {
    const amount = 10_000 * 10 ** 9

    // Create the mint to instruction manually
    const mintToTx = new Transaction().add(
      createMintToInstruction(mint, treasuryTokenAccount, employer.publicKey, amount, [], TOKEN_PROGRAM_ID),
    )

    // Set the recent blockhash
    mintToTx.recentBlockhash = context.lastBlockhash
    mintToTx.sign(employer)

    // Process the transaction
    const mintTxSignature = await banksClient.processTransaction(mintToTx)

    console.log('Mint treasury token account:', mintTxSignature)
  })

  it('This should create an employee vesting account', async () => {
    const tx2 = await program.methods
      .createEmployeeAccount(new BN(0), new BN(100), new BN(100), new BN(0))
      .accounts({
        beneficiary: beneficiary.publicKey,
        vestingAccount: vestingAccountKey,
      })
      .rpc({ commitment: 'confirmed', skipPreflight: true })

    console.log('Create employee transaction: ', tx2)
    console.log('Employee account: ', employeeAccount.toBase58())
  })

  it('Should claim the employees vested tokens', async () => {
    await new Promise((resolve) => setTimeout(resolve, 1000))
    const currentClock = await banksClient.getClock()
    context.setClock(
      new Clock(
        currentClock.slot,
        currentClock.epochStartTimestamp,
        currentClock.epoch,
        currentClock.leaderScheduleEpoch,
        1000n,
      ),
    )
    const tx3 = await program2.methods
      .claimTokens(companyName)
      .accounts({ tokenProgram: TOKEN_PROGRAM_ID })
      .rpc({ commitment: 'confirmed' })

    console.log('Claim token txn:',tx3)
  })
})
