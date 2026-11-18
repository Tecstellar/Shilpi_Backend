// FINANCIAL LEDGER SERVICE
// Strict Whole-Integer Paise Mathematics (1 INR = 100 paise)
// Zero Floating Point Errors

export class FinancialService {
  // Convert INR decimal input (e.g. 1500 or "1500.50") into paise BigInt
  static toPaise(rupees: number | string): bigint {
    const num = typeof rupees === 'string' ? parseFloat(rupees) : rupees;
    if (isNaN(num)) return 0n;
    return BigInt(Math.round(num * 100));
  }

  // Convert paise BigInt to standard Indian Rupee string formatting
  static formatRupees(paise: bigint | number): string {
    const p = typeof paise === 'bigint' ? Number(paise) : paise;
    const rupees = p / 100;
    return new Intl.NumberFormat('en-IN', {
      style: 'currency',
      currency: 'INR',
      minimumFractionDigits: 0,
      maximumFractionDigits: 2,
    }).format(rupees);
  }

  // Calculate order financials: Total, Advance, Balance Dues
  static calculateBookingLedger(items: Array<{ unitPricePaise: bigint; quantity: number }>, advancePaidPaise: bigint) {
    let totalPaise = 0n;
    for (const item of items) {
      totalPaise += item.unitPricePaise * BigInt(item.quantity);
    }

    const advance = advancePaidPaise > totalPaise ? totalPaise : advancePaidPaise;
    const balanceDuePaise = totalPaise - advance;

    return {
      totalPaise,
      advancePaidPaise: advance,
      balanceDuePaise,
    };
  }

  // Calculate Net Profit: Total Collections - Total Expenses
  static calculateNetProfit(collectionsPaise: bigint, expensesPaise: bigint): { netProfitPaise: bigint; marginPercentage: number } {
    const netProfitPaise = collectionsPaise - expensesPaise;
    const margin = collectionsPaise > 0n ? (Number(netProfitPaise) / Number(collectionsPaise)) * 100 : 0;
    return {
      netProfitPaise,
      marginPercentage: Math.round(margin * 10) / 10,
    };
  }
}
