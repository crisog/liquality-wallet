import BN from 'bignumber.js'
import { SwapProvider } from '../SwapProvider'
import { unitToCurrency, assets } from '@liquality/cryptoassets'
import { withInterval } from '../../store/actions/performNextAction/utils'
import { prettyBalance } from '../../utils/coinFormatter'
import { isERC20, getNativeAsset } from '@/utils/asset'
import { createSwapProvider } from '../../store/factory/swapProvider'
import { LiqualitySwapProvider } from '../liquality/LiqualitySwapProvider'
import { OneinchSwapProvider } from '../oneinch/OneinchSwapProvider'

const slippagePercentage = 3

class LiqualityBoostSwapProvider extends SwapProvider {
  constructor (config) {
    super(config)
    this.liqualitySwapProvider = createSwapProvider(this.config.network, 'liquality')
    this.oneinchSwapProvider = createSwapProvider(this.config.network, 'oneinchV3')
  }

  async getSupportedPairs () {
    return []
  }

  async getQuote ({ network, from, to, amount }) {
    if (isERC20(from) || !isERC20(to) || amount <= 0) return null
    const bridgeAsset = getNativeAsset(to)
    const quote = await this.liqualitySwapProvider.getQuote({ network, from, to: bridgeAsset, amount })
    if (!quote) return null
    const bridgeAssetQuantity = unitToCurrency(assets[bridgeAsset], quote.toAmount)
    const finalQuote = await this.oneinchSwapProvider.getQuote({ network, from: bridgeAsset, to, amount: bridgeAssetQuantity.toNumber() })
    if (!finalQuote) return null
    return {
      from,
      to,
      fromAmount: quote.fromAmount,
      toAmount: finalQuote.toAmount,
      bridgeAsset,
      bridgeAssetAmount: quote.toAmount
    }
  }

  async newSwap ({ network, walletId, quote: _quote }) {
    const result = await this.liqualitySwapProvider.newSwap({ network, walletId, quote: { ..._quote, to: _quote.bridgeAsset } })
    return {
      ...result,
      ..._quote,
      slippage: slippagePercentage * 100,
      bridgeAssetAmount: result.toAmount
    }
  }

  async estimateFees ({ network, walletId, asset, txType, quote, feePrices, max }) {
    const liqualityFees = await this.liqualitySwapProvider.estimateFees({ network, walletId, asset, txType, quote: { ...quote, to: quote.bridgeAsset, toAmount: quote.bridgeAssetAmount }, feePrices, max })
    if (isERC20(asset) && txType === LiqualityBoostSwapProvider.txTypes.SWAP_CLAIM) {
      const oneinchFees = await this.oneinchSwapProvider.estimateFees({ network, walletId, asset, txType: LiqualityBoostSwapProvider.txTypes.SWAP, quote: { ...quote, from: quote.bridgeAsset, fromAmount: quote.bridgeAssetAmount, fromAccountId: quote.toAccountId, slippagePercentage }, feePrices, max })
      const totalFees = {}
      for (const key in oneinchFees) {
        totalFees[key] = BN(oneinchFees[key]).plus(liqualityFees[key])
      }
      return totalFees
    }
    return liqualityFees
  }

  async finalizeLiqualitySwapAndStartOneinch ({ swap, network, walletId }) {
    const result = await this.liqualitySwapProvider.waitForClaimConfirmations({ swap, network, walletId })
    if (result?.status === 'SUCCESS') return { endTime: Date.now(), status: 'APPROVE_CONFIRMED' }
  }

  async performNextSwapAction (store, { network, walletId, swap }) {
    let updates
    const swapLiqualityFormat = { ...swap, to: swap.bridgeAsset, toAmount: swap.bridgeAssetAmount, slippagePercentage }
    const swapOneInchFormat = { ...swap, from: swap.bridgeAsset, fromAmount: swap.bridgeAssetAmount, fromAccountId: swap.toAccountId, slippagePercentage }
    if (swap.status === 'WAITING_FOR_CLAIM_CONFIRMATIONS') {
      updates = await withInterval(async () => this.finalizeLiqualitySwapAndStartOneinch({ swap: swapLiqualityFormat, network, walletId }))
    } else {
      updates = await this.liqualitySwapProvider.performNextSwapAction(store, { network, walletId, swap: swapLiqualityFormat })
    }

    if (!updates) {
      updates = await this.oneinchSwapProvider.performNextSwapAction(store, { network, walletId, swap: swapOneInchFormat })
    }
    return updates
  }

  static txTypes = {
    ...LiqualitySwapProvider.txTypes,
    ...OneinchSwapProvider.txTypes
  }

  static statuses = {
    ...LiqualitySwapProvider.statuses,
    ...OneinchSwapProvider.statuses,
    FUNDED: {
      ...LiqualitySwapProvider.statuses.FUNDED,
      label: 'Locking {bridgeAsset}'
    },
    CONFIRM_COUNTER_PARTY_INITIATION: {
      ...LiqualitySwapProvider.statuses.CONFIRM_COUNTER_PARTY_INITIATION,
      label: 'Locking {bridgeAsset}',
      notification (swap) {
        return {
          message: `Counterparty sent ${prettyBalance(swap.bridgeAssetAmount, swap.bridgeAsset)} ${swap.bridgeAsset} to escrow`
        }
      }
    },
    READY_TO_CLAIM: {
      ...LiqualitySwapProvider.statuses.READY_TO_CLAIM,
      label: 'Claiming {bridgeAsset}'
    },
    WAITING_FOR_CLAIM_CONFIRMATIONS: {
      ...LiqualitySwapProvider.statuses.WAITING_FOR_CLAIM_CONFIRMATIONS,
      label: 'Claiming {bridgeAsset}'
    },
    APPROVE_CONFIRMED: {
      ...OneinchSwapProvider.statuses.APPROVE_CONFIRMED,
      step: 3,
      label: 'Swapping {bridgeAsset} for {to}'
    },
    WAITING_FOR_SWAP_CONFIRMATIONS: {
      ...OneinchSwapProvider.statuses.WAITING_FOR_SWAP_CONFIRMATIONS,
      step: 3
    },
    SUCCESS: {
      ...LiqualitySwapProvider.statuses.SUCCESS,
      step: 4,
      label: 'Completed'
    }
  }

  static fromTxType = LiqualityBoostSwapProvider.txTypes.SWAP_INITIATION
  static toTxType = LiqualityBoostSwapProvider.txTypes.SWAP

  static totalSteps = 5
}

export { LiqualityBoostSwapProvider }
