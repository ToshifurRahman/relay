export type Feature = { n: string; label: string; body: string };
export type Tier = {
  name: string;
  blurb: string;
  price: string;
  cadence?: string;
  features: string[];
  cta: string;
  featured?: boolean;
};
export type Faq = { q: string; a: string };

export const FEATURES_HEADING = {
  label: 'Section A · How it works',
  title: 'Four stages, all on the record.',
  subtitle: 'The same four plies you just watched, in order.',
};

export const FEATURES: Feature[] = [
  {
    n: '01',
    label: 'Received',
    body: 'Your request is filed as a ticket with its own reference, the moment you send it.',
  },
  {
    n: '02',
    label: 'Triaged',
    body: "It's sorted by category and urgency, and you see both on the page.",
  },
  {
    n: '03',
    label: 'Drafted',
    body: 'A reply is written for your question, with notes kept back from your page.',
  },
  {
    n: '04',
    label: 'Replied',
    body: "The answer lands in the same thread. Anything the AI can't answer confidently is put on hold and flagged on the ops console.",
  },
];

export const PRICING_HEADING = {
  label: 'Section B',
  title: 'Rates',
  note: 'Illustrative rates from a demo build. These are not real plans: there is nothing to buy, no checkout and no billing.',
};

export const TIERS: Tier[] = [
  {
    name: 'Starter',
    blurb: 'For a single inbox',
    price: 'Free',
    features: ['Triage on every ticket', 'Drafted replies', 'Live tracking page'],
    cta: 'Try the demo',
  },
  {
    name: 'Team',
    blurb: 'For a growing support desk',
    price: '$49',
    cadence: '/ month',
    features: [
      'Everything in Starter',
      'Ops console with replay',
      'Alerts for tickets needing attention',
    ],
    cta: 'Try the demo',
    featured: true,
  },
  {
    name: 'Scale',
    blurb: 'For high-volume teams',
    price: 'Custom',
    features: ['Everything in Team', 'AI performance reporting', 'Full ticket history and audit'],
    cta: 'Try the demo',
  },
];

export const FAQ_HEADING = { label: 'Section C', title: 'Questions' };

export const FAQS: Faq[] = [
  {
    q: 'Does a person ever see my ticket?',
    a: "Anyone signed in to the ops console can see every ticket, and anything the AI can't answer confidently is put on hold and flagged there. In this demo only the owner of the deployment has that console. The ticket page updates if it moves.",
  },
  {
    q: 'How do I find my ticket again?',
    a: 'Keep your reference number. Paste it into "Track a ticket" at the top of any page. This browser also remembers the tickets you\'ve submitted.',
  },
  {
    q: 'What happens if something goes wrong?',
    a: "Your ticket stays on file. It's marked On hold and flagged on the ops console, and the page updates if it moves again.",
  },
  {
    q: 'Is my message kept private?',
    a: "Anyone with the ticket's reference can open the thread, and the operator of the demo can see it in the ops console. Internal notes never appear on your page.",
  },
  {
    q: 'Can I get the answer by email?',
    a: "Yes. Once your ticket is filed, add your email on the ticket page and we'll email you when the reply is ready, after you confirm the address. The email is a notice with a link; it never carries the reply itself.",
  },
];
