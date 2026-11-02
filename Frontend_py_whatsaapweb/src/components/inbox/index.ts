/**
 * Whatsap-Automat v0.4 — Omnichannel Inbox Public Barrel
 * Phase F3: PR-F3-04 (WCAG 2.2 AA & CAS Concurrency)
 */

export * from './types';
export * from './mockData';

// Sub-components
export * from './components/ChannelFilterTabs';
export * from './components/ConversationCard';
export * from './components/MessageBubble';
export * from './components/AiSuggestionBanner';
export * from './components/ServiceWindowWarning';
export * from './components/MessageComposer';
export * from './components/TakeoverButton';

// Panels
export * from './panels/NavigationPanel';
export * from './panels/QueuePanel';
export * from './panels/TimelinePanel';
export * from './panels/ContextPanel';

// Root component
export { OmnichannelInbox } from './OmnichannelInbox';
export { default } from './OmnichannelInbox';
