// @flow
import { compose } from 'recompose'
import { get } from 'lodash-es'
import { withData } from 'spunky'
import { withRouter } from 'react-router-dom'

import Sidebar from './Sidebar'
import { addPendingTransaction } from '../../../actions/pendingTransactionActions'

const mapPendingTransactionsDataToProps = (
  pendingTransactions: Array<any>,
) => ({
  pendingTransactionsCount: get(pendingTransactions, 'length', 0),
})

export default compose(
  withRouter, // allow `NavLink` components to re-render when the window location changes
  withData(addPendingTransaction, mapPendingTransactionsDataToProps),
)(Sidebar)
