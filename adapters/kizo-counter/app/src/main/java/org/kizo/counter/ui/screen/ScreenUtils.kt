package org.kizo.counter.ui.screen

fun formatCents(cents: Long): String {
    val dollars = cents / 100
    val pennies = cents % 100
    return "$%d.%02d".format(dollars, pennies)
}
