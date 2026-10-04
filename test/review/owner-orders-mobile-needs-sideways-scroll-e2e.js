// Правило formatting.md: до640px строка превращается в карточку,
// чтобы товар и количество не требовали горизонтального прокручивания.
process.env.REVIEW_ASSERT_MOBILE='1';
require('./ui-owner-main-screens-e2e');
