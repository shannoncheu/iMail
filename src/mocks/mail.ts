import type {
  MailAccount,
  MailFolder,
  MailParticipant,
  MailThread,
  ProviderSource,
  ThreadMessage,
} from "@/src/providers/mail/MailProvider";

const me: MailParticipant = {
  name: "You",
  email: "me@private.example.test",
};

export const mockAccounts: MailAccount[] = [
  {
    id: "account-gmail",
    provider: "gmail",
    label: "Personal",
    address: "me@personal.example.test",
    color: "#d96555",
    connected: true,
    capabilities: {
      labels: true,
      reliableDraftUpdates: true,
      externalImages: true,
      permanentDelete: false,
    },
  },
  {
    id: "account-outlook",
    provider: "outlook",
    label: "Everyday",
    address: "me@everyday.example.test",
    color: "#3f78bd",
    connected: true,
    capabilities: {
      labels: false,
      reliableDraftUpdates: true,
      externalImages: true,
      permanentDelete: true,
    },
  },
  {
    id: "account-zoho",
    provider: "zoho",
    label: "Studio",
    address: "hello@studio.example.test",
    color: "#c68a35",
    connected: true,
    capabilities: {
      labels: true,
      reliableDraftUpdates: false,
      externalImages: true,
      permanentDelete: true,
    },
  },
];

export const baseFolders: MailFolder[] = [
  { id: "inbox", label: "Inbox", count: 18 },
  { id: "starred", label: "Starred", count: 5 },
  { id: "sent", label: "Sent" },
  { id: "drafts", label: "Drafts", count: 2 },
  { id: "archive", label: "Archive" },
  { id: "spam", label: "Spam" },
  { id: "trash", label: "Trash" },
];

const participant = (name: string, local: string): MailParticipant => ({
  name,
  email: `${local}@example.test`,
});

const article = (
  id: string,
  sender: MailParticipant,
  sentAt: string,
  sentAtFull: string,
  body: string[],
  attachments: ThreadMessage["attachments"] = [],
): ThreadMessage => ({
  id,
  sender,
  recipients: [me],
  sentAt,
  sentAtFull,
  body,
  attachments,
});

const primaryThreads: MailThread[] = [
  {
    id: "design-review",
    provider: "gmail",
    accountId: "account-gmail",
    folder: "inbox",
    sender: participant("Lina Park", "lina.park"),
    subject: "Reading mode — final interaction review",
    preview:
      "The quiet layout is working. I left three small notes around thread spacing and the image guard…",
    receivedAt: "10:42",
    receivedAtFull: "18 August 2026 at 10:42",
    unread: true,
    starred: true,
    labels: ["Design", "Review"],
    hasExternalImages: false,
    messages: [
      article(
        "design-review-1",
        participant("Lina Park", "lina.park"),
        "Yesterday, 16:20",
        "17 August 2026 at 16:20",
        [
          "I reviewed the new reading surface on desktop and mobile. The overall direction feels calm without becoming empty.",
          "My main suggestion is to keep the sender header compact until it is expanded. That gives long threads more breathing room and keeps attention on the message itself.",
        ],
      ),
      article(
        "design-review-2",
        me,
        "Yesterday, 18:06",
        "17 August 2026 at 18:06",
        [
          "Agreed. I also separated the selected state from keyboard focus, so the list no longer relies on one blue highlight for everything.",
          "I’ll send a final pass with the reduced-motion behavior included.",
        ],
      ),
      article(
        "design-review-3",
        participant("Lina Park", "lina.park"),
        "10:42",
        "18 August 2026 at 10:42",
        [
          "The quiet layout is working. I left three small notes around thread spacing and the image guard, but none of them block the next build.",
          "The attachment treatment is especially good: it feels like part of the message instead of a separate dashboard widget.",
          "When you have a moment, please check the annotated review file. After that, I think this is ready for the mock-data milestone.",
        ],
        [
          {
            id: "att-review",
            name: "interaction-review.pdf",
            size: "2.4 MB",
            kind: "document",
          },
          {
            id: "att-notes",
            name: "spacing-notes.png",
            size: "860 KB",
            kind: "image",
          },
        ],
      ),
    ],
  },
  {
    id: "sunday-briefing",
    provider: "outlook",
    accountId: "account-outlook",
    folder: "inbox",
    sender: participant("Northstar Journal", "briefing"),
    subject: "A slower Sunday: five things worth keeping",
    preview:
      "A compact collection of essays, tools and small ideas for a quieter week ahead…",
    receivedAt: "09:18",
    receivedAtFull: "18 August 2026 at 09:18",
    unread: true,
    starred: false,
    labels: ["Reading"],
    hasExternalImages: true,
    messages: [
      article(
        "sunday-briefing-1",
        participant("Northstar Journal", "briefing"),
        "09:18",
        "18 August 2026 at 09:18",
        [
          "Good morning. This week’s note is about creating useful constraints: fewer tools, shorter lists and one quiet place to return to.",
          "Inside: a field guide to personal archives, a thoughtful essay on humane software, and a small collection of ambient recordings.",
        ],
      ),
    ],
  },
  {
    id: "travel-change",
    provider: "gmail",
    accountId: "account-gmail",
    folder: "inbox",
    sender: participant("Aster Travel", "journeys"),
    subject: "Your itinerary has changed",
    preview:
      "The departure time for your Wednesday journey has moved by 25 minutes…",
    receivedAt: "08:41",
    receivedAtFull: "18 August 2026 at 08:41",
    unread: false,
    starred: false,
    labels: ["Travel"],
    hasExternalImages: true,
    messages: [
      article(
        "travel-change-1",
        participant("Aster Travel", "journeys"),
        "08:41",
        "18 August 2026 at 08:41",
        [
          "Your departure is now scheduled for 14:55 on Wednesday. Your seat and reservation reference are unchanged.",
          "No action is required. The updated itinerary is attached for offline reference.",
        ],
        [
          {
            id: "att-itinerary",
            name: "updated-itinerary.pdf",
            size: "184 KB",
            kind: "document",
          },
        ],
      ),
    ],
  },
  {
    id: "invoice-august",
    provider: "zoho",
    accountId: "account-zoho",
    folder: "inbox",
    sender: participant("Moss & Field", "accounts"),
    subject: "Invoice and project summary — August",
    preview:
      "Attached is the August invoice together with a short summary of completed work…",
    receivedAt: "Yesterday",
    receivedAtFull: "17 August 2026 at 18:12",
    unread: false,
    starred: true,
    labels: ["Finance", "Studio"],
    hasExternalImages: false,
    messages: [
      article(
        "invoice-august-1",
        participant("Moss & Field", "accounts"),
        "Yesterday, 18:12",
        "17 August 2026 at 18:12",
        [
          "Hello, attached is the August invoice together with a short summary of the work completed this month.",
          "Please reply if you would like the line items grouped differently for your records.",
        ],
        [
          {
            id: "att-invoice",
            name: "invoice-2026-08.pdf",
            size: "96 KB",
            kind: "document",
          },
        ],
      ),
    ],
  },
  {
    id: "access-review",
    provider: "outlook",
    accountId: "account-outlook",
    folder: "inbox",
    sender: participant("Private Hub", "security"),
    subject: "New sign-in reviewed successfully",
    preview:
      "The new browser session was verified and is now listed under Security…",
    receivedAt: "Yesterday",
    receivedAtFull: "17 August 2026 at 14:03",
    unread: false,
    starred: false,
    labels: ["Security"],
    hasExternalImages: false,
    messages: [
      article(
        "access-review-1",
        participant("Private Hub", "security"),
        "Yesterday, 14:03",
        "17 August 2026 at 14:03",
        [
          "The new browser session was verified successfully. You can review active sessions from Settings → Security.",
          "If you do not recognize this activity, revoke the session and disconnect the affected provider account.",
        ],
      ),
    ],
  },
  {
    id: "weekly-notes",
    provider: "zoho",
    accountId: "account-zoho",
    folder: "inbox",
    sender: participant("Noah Chen", "noah.chen"),
    subject: "Studio notes / week 33",
    preview:
      "A short recap from this week: copy is locked, mobile states are mapped, and the remaining questions…",
    receivedAt: "Mon",
    receivedAtFull: "17 August 2026 at 09:20",
    unread: true,
    starred: false,
    labels: ["Studio"],
    hasExternalImages: false,
    messages: [
      article(
        "weekly-notes-1",
        participant("Noah Chen", "noah.chen"),
        "Mon, 09:20",
        "17 August 2026 at 09:20",
        [
          "A short recap from this week: copy is locked, mobile states are mapped, and the remaining questions are all implementation details.",
          "I added a small set of edge cases to the handoff, including an empty thread, delayed attachment upload and partial provider failure.",
        ],
      ),
    ],
  },
  {
    id: "dinner-friday",
    provider: "gmail",
    accountId: "account-gmail",
    folder: "inbox",
    sender: participant("Maya Ito", "maya.ito"),
    subject: "Friday evening",
    preview: "Seven works for me. I’ll book the quiet table near the back window…",
    receivedAt: "Sun",
    receivedAtFull: "16 August 2026 at 20:14",
    unread: false,
    starred: true,
    labels: ["Personal"],
    hasExternalImages: false,
    messages: [
      article(
        "dinner-friday-1",
        participant("Maya Ito", "maya.ito"),
        "Sun, 18:02",
        "16 August 2026 at 18:02",
        ["Would Friday evening work? There’s a small place I’ve been meaning to try."],
      ),
      article(
        "dinner-friday-2",
        me,
        "Sun, 19:44",
        "16 August 2026 at 19:44",
        ["Friday is good. Would seven be too late?"],
      ),
      article(
        "dinner-friday-3",
        participant("Maya Ito", "maya.ito"),
        "Sun, 20:14",
        "16 August 2026 at 20:14",
        ["Seven works for me. I’ll book the quiet table near the back window."],
      ),
    ],
  },
  {
    id: "archive-receipt",
    provider: "outlook",
    accountId: "account-outlook",
    folder: "archive",
    sender: participant("Common Room", "receipts"),
    subject: "Receipt for your annual membership",
    preview: "Thank you. Your membership has been renewed through August 2027…",
    receivedAt: "12 Aug",
    receivedAtFull: "12 August 2026 at 11:32",
    unread: false,
    starred: false,
    labels: ["Receipts"],
    hasExternalImages: false,
    messages: [
      article(
        "archive-receipt-1",
        participant("Common Room", "receipts"),
        "12 Aug, 11:32",
        "12 August 2026 at 11:32",
        ["Thank you. Your membership has been renewed through August 2027."],
      ),
    ],
  },
  {
    id: "sent-followup",
    provider: "zoho",
    accountId: "account-zoho",
    folder: "sent",
    sender: me,
    subject: "Follow-up notes from today",
    preview: "Here are the decisions we made, together with the two items still open…",
    receivedAt: "11 Aug",
    receivedAtFull: "11 August 2026 at 17:04",
    unread: false,
    starred: false,
    labels: ["Studio"],
    hasExternalImages: false,
    messages: [
      article(
        "sent-followup-1",
        me,
        "11 Aug, 17:04",
        "11 August 2026 at 17:04",
        ["Here are the decisions we made, together with the two items still open."],
      ),
    ],
  },
  {
    id: "draft-quiet-launch",
    provider: "gmail",
    accountId: "account-gmail",
    folder: "drafts",
    sender: me,
    subject: "A quieter way to read everything",
    preview: "I wanted one place for the messages I actually care about, without another feed…",
    receivedAt: "Draft",
    receivedAtFull: "Draft saved 18 August 2026 at 08:12",
    unread: false,
    starred: false,
    labels: ["Draft"],
    hasExternalImages: false,
    messages: [
      article(
        "draft-quiet-launch-1",
        me,
        "Draft",
        "Draft saved 18 August 2026 at 08:12",
        [
          "I wanted one place for the messages I actually care about, without another feed competing for attention.",
        ],
      ),
    ],
  },
];

const generatedSenders = [
  ["Elliot Ward", "elliot.ward"],
  ["Juniper Books", "notes"],
  ["Sana Malik", "sana.malik"],
  ["Fieldwork", "hello"],
  ["Theo Martin", "theo.martin"],
  ["Cedar Workshop", "studio"],
] as const;

const generatedSubjects = [
  "A small update before Thursday",
  "Notes from the research session",
  "Your reservation is confirmed",
  "Three references for the next pass",
  "Monthly account summary",
  "Re: the quieter option",
] as const;

const providerCycle: ProviderSource[] = ["gmail", "outlook", "zoho"];

const generatedThreads: MailThread[] = Array.from({ length: 24 }, (_, index) => {
  const senderSeed = generatedSenders[index % generatedSenders.length];
  const sender = participant(senderSeed[0], `${senderSeed[1]}.${index + 1}`);
  const provider = providerCycle[index % providerCycle.length];
  const accountId = `account-${provider}`;
  const subject = generatedSubjects[index % generatedSubjects.length];
  const day = 15 - (index % 12);

  return {
    id: `generated-${index + 1}`,
    provider,
    accountId,
    folder: "inbox",
    sender,
    subject,
    preview:
      "A concise note with the context, next decision and one useful attachment for later reference…",
    receivedAt: `${day} Aug`,
    receivedAtFull: `${day} August 2026 at ${String(9 + (index % 8)).padStart(2, "0")}:20`,
    unread: index % 4 === 0,
    starred: index % 7 === 0,
    labels: index % 2 === 0 ? ["Reference"] : [],
    hasExternalImages: index % 5 === 0,
    messages: [
      article(
        `generated-message-${index + 1}`,
        sender,
        `${day} Aug`,
        `${day} August 2026 at ${String(9 + (index % 8)).padStart(2, "0")}:20`,
        [
          "A concise note with the context, next decision and one useful detail for later reference.",
          "There is no urgency. Reply whenever you have had time to look through it properly.",
        ],
      ),
    ],
  };
});

export const mockThreads: MailThread[] = [...primaryThreads, ...generatedThreads];
