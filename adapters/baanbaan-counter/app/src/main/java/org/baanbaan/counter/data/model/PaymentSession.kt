package org.baanbaan.counter.data.model

data class PaymentSession(
    val orderId: String,
    val amountCents: Long,
    val currency: String = "USD",
    val tipOptions: List<Int> = emptyList(),
    val tipCents: Long = 0L,
    val signatureBase64: String? = null,
    val transactionId: String? = null,
    val status: PaymentStatus = PaymentStatus.PENDING,
    val errorMessage: String? = null,
    val receiptRequested: Boolean = false,
    val receiptEmail: String? = null
) {
    val totalCents: Long get() = amountCents + tipCents
}

enum class PaymentStatus {
    PENDING,
    PROCESSING,
    APPROVED,
    DECLINED,
    ERROR,
    CANCELLED
}
