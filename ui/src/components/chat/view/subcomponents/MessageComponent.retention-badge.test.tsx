// @vitest-environment jsdom
//
// The retention badge is the *live-demo* path: it is what a judge actually sees
// on screen when they watch a compaction happen in the Web UI. The mapper that
// feeds it has a unit test (`useChatMessages.retention.test.ts`), but a correct
// mapper plus a broken render still shows nothing — and nothing else in the
// suite renders this branch. So this file renders it for real, for both the
// English and Chinese bundles, and once through the full wire -> UI path.

import { cleanup, render, screen } from '@testing-library/react';
import i18n, { type i18n as I18n } from 'i18next';
import { initReactI18next, I18nextProvider } from 'react-i18next';
import { afterEach, describe, expect, it } from 'vitest';

import type { NormalizedMessage } from '../../../../stores/useSessionStore';
import enChat from '../../../../i18n/locales/en/chat.json';
import zhChat from '../../../../i18n/locales/zh-CN/chat.json';
import type { ChatMessage } from '../../types/types';
import { normalizedToChatMessages } from '../../hooks/useChatMessages';
import MessageComponent from './MessageComponent';

// A dedicated instance rather than the app singleton: this keeps the assertions
// independent of whichever module happened to initialize i18n first.
function makeI18n(language: 'en' | 'zh-CN'): I18n {
  const instance = i18n.createInstance();
  instance.use(initReactI18next).init({
    resources: language === 'en' ? { en: { chat: enChat } } : { 'zh-CN': { chat: zhChat } },
    lng: language,
    ns: ['chat'],
    defaultNS: 'chat',
    keySeparator: '.',
    nsSeparator: ':',
    interpolation: { escapeValue: false },
    initImmediate: false,
    react: { useSuspense: false },
  });
  return instance;
}

afterEach(cleanup);

function renderBoundary(message: ChatMessage, language: 'en' | 'zh-CN' = 'en') {
  return render(
    <I18nextProvider i18n={makeI18n(language)}>
      <MessageComponent
        message={message}
        prevMessage={null}
        createDiff={() => []}
        provider="pilotdeck"
        onShowSettings={() => {}}
      />
    </I18nextProvider>,
  );
}

const boundary: ChatMessage = {
  id: 'compact',
  type: 'system',
  content: 'Context compacted',
  timestamp: '2026-09-11T00:00:01.000Z',
  isCompactBoundary: true,
  compactionId: 'compact-1',
  compactTrigger: 'auto',
  preTokens: 15320,
  postTokens: 4200,
  compactRetention: {
    policyId: 'ebbinghaus-pagerank',
    retainedMessages: 3,
    retainedTokens: 1204,
    budgetTokens: 2048,
    weights: { wSim: 0.85, wTime: 0.15, wRank: 0 },
  },
};

describe('retention badge', () => {
  it('renders the retained count and token volume a viewer reads on screen', () => {
    renderBoundary(boundary);

    expect(screen.getByText(/Hippo kept 3 msgs verbatim \(1,204 tok\)/)).toBeTruthy();
    // The compaction line itself must still render alongside the badge.
    expect(screen.getByText('Context compacted')).toBeTruthy();
    expect(screen.getByText(/15,320 → 4,200 tokens/)).toBeTruthy();
  });

  it('surfaces the policy and budget on hover', () => {
    renderBoundary(boundary);

    const badge = screen.getByText(/Hippo kept 3 msgs/);
    expect(badge.getAttribute('title')).toContain('ebbinghaus-pagerank');
    expect(badge.getAttribute('title')).toContain('2,048 tokens');
  });

  it('renders the Chinese badge without leaking a raw i18n key', () => {
    renderBoundary(boundary, 'zh-CN');

    expect(screen.getByText(/Hippo 逐字保留 3 条（1,204 tok）/)).toBeTruthy();
    expect(screen.queryByText(/compact\.retention/)).toBeNull();
  });

  it('renders no badge on an upstream compaction boundary', () => {
    const { compactRetention: _dropped, ...upstreamBoundary } = boundary;
    renderBoundary(upstreamBoundary);

    // The boundary line is upstream behaviour and must be untouched...
    expect(screen.getByText('Context compacted')).toBeTruthy();
    // ...but there is nothing retained to report, so no badge claims otherwise.
    expect(screen.queryByText(/verbatim/)).toBeNull();
  });

  it('renders the badge from raw wire metadata through the real conversion path', () => {
    // The strongest form of this test: nothing here is hand-built except the
    // message the server would actually send.
    const wire: NormalizedMessage[] = [
      {
        id: 'compact',
        sessionId: 'web:s_retention',
        timestamp: '2026-09-11T00:00:01.000Z',
        provider: 'pilotdeck',
        kind: 'compact_boundary',
        turnId: 'turn-compact',
        compactionId: 'compact-1',
        trigger: 'auto',
        preTokens: 15320,
        postTokens: 4200,
        messagesSummarized: 18,
        compactMetadata: {
          retention: {
            policyId: 'ebbinghaus-pagerank',
            retainedMessages: 3,
            retainedTokens: 1204,
            budgetTokens: 2048,
            weights: { wSim: 0.85, wTime: 0.15, wRank: 0 },
          },
        },
      },
    ];

    const [converted] = normalizedToChatMessages(wire);
    expect(converted?.compactRetention?.retainedMessages).toBe(3);

    renderBoundary(converted!);
    expect(screen.getByText(/Hippo kept 3 msgs verbatim \(1,204 tok\)/)).toBeTruthy();
  });

  it('renders no badge when the wire reports nothing retained', () => {
    const wire: NormalizedMessage[] = [
      {
        id: 'compact',
        sessionId: 'web:s_retention',
        timestamp: '2026-09-11T00:00:01.000Z',
        provider: 'pilotdeck',
        kind: 'compact_boundary',
        compactionId: 'compact-1',
        trigger: 'auto',
        preTokens: 15320,
        compactMetadata: { retention: { retainedMessages: 0 } },
      },
    ];

    const [converted] = normalizedToChatMessages(wire);
    renderBoundary(converted!);

    expect(screen.getByText('Context compacted')).toBeTruthy();
    expect(screen.queryByText(/verbatim/)).toBeNull();
  });
});
