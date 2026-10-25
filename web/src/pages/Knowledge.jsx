import { useProject } from '../lib/context.js';
import { href } from '../lib/router.js';
import { EmbeddedContext, PageHeader, Tabs } from '../components/ui.jsx';
import { Learn } from './Learn.jsx';
import { Documents } from './knowledge/Documents.jsx';
import { DocView } from './knowledge/Search.jsx';
import { Ask, Decisions, TeamQuestions } from './knowledge/Ask.jsx';

export { Highlight } from './knowledge/Search.jsx';
export { TeamQuestions } from './knowledge/Ask.jsx';

export function Knowledge({ route }) {
  const { project, counts } = useProject();
  const [sub, a, b] = route.rest;
  if (sub === 'doc' && a) return <DocView docId={a} anchor={b} />;
  // Learn is a tab here. Its documents, quizzes and onboarding paths open as their own pages, like a knowledge document.
  const learnRoute = { ...route, rest: route.rest.slice(1) };
  if (sub === 'learn' && ['doc', 'quiz', 'path'].includes(a) && learnRoute.rest[1]) return <Learn route={learnRoute} />;
  // The questions tab was called "inbox"; that word now belongs to the cross-project Inbox, but old links still work.
  const tab = sub === 'inbox' || sub === 'questions' ? 'questions' : ['ask', 'decisions', 'learn'].includes(sub) ? sub : 'docs';
  return (
    <div className="page">
      <PageHeader title="Knowledge" sub="Project documents agents search before they answer, and the questions the team still has to answer." />
      <Tabs
        value={tab}
        tabs={[
          { value: 'docs', label: 'Documents', href: href(project.id, 'knowledge') },
          { value: 'ask', label: 'Ask', href: href(project.id, 'knowledge', 'ask') },
          { value: 'questions', label: 'Team questions', href: href(project.id, 'knowledge', 'questions'), count: counts.open_questions },
          { value: 'learn', label: 'Learn', href: href(project.id, 'learn') },
          { value: 'decisions', label: 'Decisions log', href: href(project.id, 'knowledge', 'decisions') },
        ]}
      />
      {tab === 'docs' ? (
        <Documents />
      ) : tab === 'ask' ? (
        <Ask />
      ) : tab === 'questions' ? (
        <TeamQuestions />
      ) : tab === 'learn' ? (
        <EmbeddedContext.Provider value>
          <Learn route={learnRoute} />
        </EmbeddedContext.Provider>
      ) : (
        <Decisions />
      )}
    </div>
  );
}
