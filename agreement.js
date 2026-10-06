// Orion Client Agreement & Risk Disclosure — the text clients e-sign.
// Wording is the version drafted in the earlier chat, with two changes:
//  - Section 4 fee terms come from the AGREEMENT_FEE_TERMS env var instead of a placeholder
//  - v2: the Operator is simply "Orion" (no personal name or company named)
//  - v3: added mirrored-trades-differ bullet (s2), client responsibilities (s8), data (s9), governing law (s10)
//  - Section 8 refers to ticking the boxes and typing a name instead of a print-and-sign block
// **double asterisks** mark bold. Bump VERSION whenever the wording changes; each
// signed record stores the version, a hash and a full copy of the text as signed.

const VERSION = '2026-10-v3';

function sections(feeTerms) {
  return [
    {
      h: '1. What This Service Is',
      p: [
        'The Operator runs \u201cOrion,\u201d an automated trading system that executes Bitcoin perpetual futures trades. Clients who join this service have their own Hyperliquid account automatically mirror the same trades, in proportion to their own account balance.',
        'The Operator does not provide personalised financial advice. This service is the automated execution of a trading strategy, not investment advisory services.',
      ],
    },
    {
      h: '2. Risk Disclosure \u2014 Please Read Carefully',
      p: ['**Trading cryptocurrency derivatives carries a substantial risk of loss and is not suitable for everyone.**'],
      b: [
        'The value of the Client\u2019s account can go down as well as up. The Client may lose some, or all, of the funds they deposit.',
        'Leverage is used in this strategy. Leverage magnifies both gains and losses \u2014 a relatively small adverse price movement can result in a significant loss.',
        'Past performance \u2014 including any performance target mentioned to the Client \u2014 is not a guarantee, promise, or reliable indicator of future results.',
        'Any target return referenced by the Operator (for example, in relation to a monthly cycle) is an aim the strategy is run towards, not a guaranteed or contracted outcome. The Operator makes no representation that any specific return will be achieved in any given period.',
        'Cryptocurrency markets operate 24/7, are highly volatile, and can move sharply with little warning.',
        'Trades mirrored to the Client\u2019s account are not exact copies of the Operator\u2019s own trades. Prices, sizes, timing and fees may differ, and some orders may fail or be delayed, so the Client\u2019s results may be different from, and worse than, those of any other account.',
        'Hyperliquid, the exchange used for this service, is not authorised or regulated by the UK Financial Conduct Authority (FCA). The FCA has published a warning regarding Hyperliquid. This means the Financial Ombudsman Service and the Financial Services Compensation Scheme (FSCS) do not apply to funds held there.',
      ],
      p2: ['The Client confirms they understand these risks and are trading with funds they can afford to lose.'],
    },
    {
      h: '3. Custody of Funds \u2014 What the Operator Can and Cannot Do',
      p: [
        'The Client\u2019s funds remain in the Client\u2019s own Hyperliquid account at all times. The Operator never takes custody of, holds, or has access to withdraw the Client\u2019s funds.',
        'To execute mirrored trades, the Client grants the Operator a Hyperliquid **agent wallet** authorisation. An agent wallet can only place and manage trades on the Client\u2019s behalf \u2014 it **cannot** withdraw, transfer, or move the Client\u2019s funds under any circumstances. The Client may revoke this authorisation at any time directly within their own Hyperliquid account, independently of the Operator.',
      ],
    },
    {
      h: '4. Fees',
      p: [
        feeTerms,
        'Fees are payable in advance of each billing cycle unless otherwise agreed in writing. The Client\u2019s account will continue to be mirrored for the duration of a paid cycle regardless of trading performance during that cycle, subject to Section 2 above.',
      ],
    },
    {
      h: '5. Ending This Agreement',
      p: ['Either party may end this arrangement at any time, for any reason, with notice to the other.'],
      b: [
        'The Client may stop the service at any time by notifying the Operator and/or revoking the agent wallet\u2019s authorisation directly on Hyperliquid.',
        'The Operator may stop mirroring the Client\u2019s account at any time, including (without limitation) where fees are unpaid, where the Client\u2019s account is not adequately funded, or at the Operator\u2019s discretion.',
        'Ending this agreement does not entitle the Client to a refund of fees already paid for the current billing cycle, unless otherwise agreed.',
      ],
    },
    {
      h: '6. Limitation of Liability',
      p: ['To the fullest extent permitted by law, the Operator is not liable for any trading losses incurred in the Client\u2019s account, including losses arising from normal strategy performance, exchange outages, network issues, or events outside the Operator\u2019s reasonable control. Nothing in this agreement excludes liability that cannot be excluded by law.'],
    },
    {
      h: '7. No Advice / No Guarantee',
      p: ['Nothing provided by the Operator \u2014 including any dashboard, report, statement, or communication \u2014 constitutes financial, investment, tax, or legal advice. The Client is solely responsible for their own decision to participate in this service and should seek independent professional advice if unsure.'],
    },
    {
      h: '8. Client Responsibilities',
      p: ['The Client confirms they are aged 18 or over, and that they are responsible for their own tax affairs, including reporting and paying any tax due on gains from this service.'],
    },
    {
      h: '9. Your Information',
      p: ['The Operator records the Client\u2019s name, wallet address and the details of this signing (including the time, IP address and browser used) in order to provide the service and to keep a record of this agreement.'],
    },
    {
      h: '10. Governing Law',
      p: ['This agreement is governed by the law of England and Wales.'],
    },
    {
      h: '11. Acknowledgement & Signature',
      p: ['By ticking the boxes and typing their name below, the Client confirms they have read and understood this agreement in full, including the risk disclosure in Section 2, and agree to participate in the Orion mirror trading service on these terms. Typing their name is the Client\u2019s electronic signature.'],
    },
  ];
}

const PREAMBLE = 'This agreement is between **Orion** (\u201cthe Operator\u201d) and the client who signs it (\u201cthe Client\u201d), and sets out the terms on which the Operator provides an automated cryptocurrency trade-mirroring service.';

const CONSENTS = [
  'I have read and understood this agreement in full, including the risk disclosure in Section 2.',
  'I understand I can lose some or all of my money, that any return figure is a target and not a guarantee, and that Hyperliquid is not regulated by the FCA, so there is no Ombudsman or FSCS protection.',
  'I agree to these terms, including the fees in Section 4 and the agent wallet authorisation in Section 3, and I am trading only with funds I can afford to lose.',
];

// Plain-text rendering, used for the hash and the stored copy of what was signed.
function toText(feeTerms) {
  const strip = (s) => s.replace(/\*\*/g, '');
  const out = ['ORION MIRROR TRADING \u2014 Client Agreement & Risk Disclosure', '', strip(PREAMBLE), ''];
  for (const s of sections(feeTerms)) {
    out.push(s.h);
    (s.p || []).forEach((t) => out.push(strip(t)));
    (s.b || []).forEach((t) => out.push('  \u2022 ' + strip(t)));
    (s.p2 || []).forEach((t) => out.push(strip(t)));
    out.push('');
  }
  out.push('Consents given:');
  CONSENTS.forEach((c, i) => out.push(`  [x] ${i + 1}. ${c}`));
  return out.join('\n');
}

module.exports = { VERSION, sections, PREAMBLE, CONSENTS, toText };
