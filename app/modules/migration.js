// @flow
import axios from 'axios'
import { keyBy } from 'lodash-es'
// import { wallet } from '@cityofzion/neon-js'

import { getNode, getRPCEndpoint } from '../actions/nodeStorageActions'
import { addPendingTransaction } from '../actions/pendingTransactionActions'
import { getAssetBalances, getTokenBalances, getWIF } from '../core/deprecated'
import {
  showErrorNotification,
  showInfoNotification,
  showSuccessNotification,
} from './notifications'
import { getTokenBalancesMap } from '../core/wallet'
import { toBigNumber } from '../core/math'
import { buildTransferScript } from './transactions'

const N2 = require('@cityofzion/neon-js-legacy-latest')
const N3 = require('@cityofzion/neon-js-next')
const { wallet } = require('@cityofzion/neon-js-legacy-latest')

const populateTestNetBalances = async (address: string) => {
  const net = 'TestNet'

  const testnetBalances = await axios.get(
    `https://dora.coz.io/api/v1/neo2/testnet/get_balance/${address}`,
  )
  const parsedTestNetBalances = {}

  testnetBalances.data.balance.forEach(token => {
    parsedTestNetBalances[token.asset_symbol || token.symbol] = {
      name: token.asset_symbol || token.symbol,
      balance: token.amount,
      unspent: token.unspent,
    }
  })

  const Balance = new wallet.Balance({
    address,
    net,
  })

  Object.values(parsedTestNetBalances).forEach(
    // $FlowFixMe
    ({ name, balance, unspent }) => {
      if (name === 'GAS' || name === 'NEO') {
        Balance.addAsset(name, { balance, unspent })
      } else {
        Balance.addToken(name, balance)
      }
    },
  )

  return Balance
}

export const performMigration = ({
  sendEntries,
}: {
  sendEntries: Array<SendEntryType>,
}) => (dispatch: DispatchType, getState: GetStateType): Promise<*> =>
  // TODO: will need to be dynamic based on network
  // eslint-disable-next-line
  // const provider = new N2.api.neoCli.instance('https://testnet1.neo2.coz.io')

  new Promise(async (resolve, reject) => {
    try {
      const state = getState()
      const wif = getWIF(state)
      const tokenBalances = getTokenBalances(state)
      const balances = {
        ...getAssetBalances(state),
        ...getTokenBalancesMap(tokenBalances),
      }
      const tokensBalanceMap = keyBy(tokenBalances, 'symbol')
      const TO_ACCOUNT = new N3.wallet.Account(wif)
      const FROM_ACCOUNT = new N2.wallet.Account(wif)
      const entry = sendEntries[0]

      // eslint-disable-next-line
      const net = state.spunky.network.data == 1 ? 'MainNet' : 'TestNet'
      let endpoint = await getNode(net)
      if (!endpoint) {
        endpoint = await getRPCEndpoint(net)
      }
      // eslint-disable-next-line
      const provider = new N2.api.neoCli.instance(endpoint)
      const { symbol, amount, address } = entry
      let intent
      let script = ''

      if (symbol === 'GAS' || symbol === 'NEO') {
        intent = N2.api.makeIntent({ [symbol]: Number(amount) }, address)
      } else {
        script = buildTransferScript(
          net,
          sendEntries,
          FROM_ACCOUNT.address,
          // $FlowFixMe
          tokensBalanceMap,
        )
      }

      if (symbol === 'nNEO' && Number(amount) < 1) {
        return dispatch(
          showErrorNotification({
            message: 'Oops... you cannot migrate less than 1 nNEO.',
          }),
        )
      }

      const hexRemark = N2.u.str2hexstring(TO_ACCOUNT.address)
      const hexTagRemark = N2.u.str2hexstring('Neon Desktop Migration')

      const hasBalanceForRequiredFee = (MIN_FEE = 1) => {
        if (
          !balances.GAS ||
          (balances.GAS && toBigNumber(balances.GAS).lt(MIN_FEE))
        ) {
          return false
        }
        return true
      }

      const feeIsRequired = () => {
        const userMustPayFee =
          (symbol === 'NEO' && Number(amount) < 10) ||
          (symbol === 'GAS' && Number(amount) < 20) ||
          (symbol === 'CGAS' && Number(amount) < 20) ||
          (symbol === 'nNEO' && Number(amount) < 10)

        return userMustPayFee
      }

      if (!hasBalanceForRequiredFee() && feeIsRequired()) {
        const generateMinRequirementString = () => {
          const requirementMap = {
            GAS: ' OR migrate at least 20 GAS.',
            NEO: ' OR migrate at least 10 NEO.',
            nNEO: '.',
            CGAS: '.',
            OTHER: '.',
          }

          if (requirementMap[symbol]) {
            return requirementMap[symbol]
          }
          return requirementMap.OTHER
        }
        const message = `Account does not have enough to cover the 1 GAS fee... Please transfer at least 1 GAS to ${
          FROM_ACCOUNT.address
        } to proceed${generateMinRequirementString()}`
        const error = new Error(message)
        dispatch(
          showErrorNotification({
            message,
            autoDismiss: 10000,
          }),
        )
        return reject(error)
      }

      const CONFIG = {
        api: provider,
        account: FROM_ACCOUNT,
        intents: intent,
        fees: feeIsRequired() ? 1.0 : null,
        script,
      }

      dispatch(
        showInfoNotification({
          message: 'Broadcasting transaction to network...',
          autoDismiss: 0,
        }),
      )

      let c = await N2.api.fillSigningFunction(CONFIG)
      c = await N2.api.fillUrl(c)
      // if (net !== 'TestNet') {
      c = await N2.api.fillBalance(c)

      if (symbol === 'GAS' || symbol === 'NEO') {
        const { balance } = c
        if (
          balance.assets[symbol].unspent.length &&
          balance.assets[symbol].unspent.length > 15
        ) {
          dispatch(
            showErrorNotification({
              message:
                'This migration transaction has an excessive number of UTXO inputs and will require extra GAS in fees. Consider sending all your (GAS|NEO) to yourself first in order to consolidate your UTXOs into a single input before migrating, in order to avoid the extra fee.',
            }),
          )
          return reject()
        }
      }

      c = script
        ? await N2.api.createInvocationTx(c)
        : await N2.api.createContractTx(c)

      c.tx.attributes.push(
        new N2.tx.TransactionAttribute({
          usage: N2.tx.TxAttrUsage.Remark14,
          data: hexRemark,
        }),
        new N2.tx.TransactionAttribute({
          usage: N2.tx.TxAttrUsage.Remark15,
          data: hexTagRemark,
        }),
      )
      c = await N2.api.signTx(c)
      c = await N2.api.sendTx(c)
      // eslint-disable-next-line
      if (c.response.hasOwnProperty('txid')) {
        // eslint-disable-next-line
        console.log(
          `Swap initiated to ${TO_ACCOUNT.address} in tx 0x${c.response.txid}`,
        )

        dispatch(
          showSuccessNotification({
            message:
              'Transaction pending! Your balance will automatically update when the blockchain has processed it.',
          }),
        )

        dispatch(
          addPendingTransaction.call({
            address: c.account.address,
            tx: {
              hash: c.response.txid,
              sendEntries,
            },
            net,
          }),
        )

        return resolve()
      }
    } catch (e) {
      dispatch(
        showErrorNotification({
          message: `Oops... Something went wrong please try again. ${
            e.message
          }`,
        }),
      )
      return reject(e)
    }
  })
