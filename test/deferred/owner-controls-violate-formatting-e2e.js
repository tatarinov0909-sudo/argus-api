// Две видимые области проверяются через реальные страницы и локальный API:
// native select в поставках, Consolas вместо Golos Text в числах сверки WB.
process.env.REVIEW_ASSERT_FORMATTING='1';
require('../review/ui-owner-main-screens-e2e');
