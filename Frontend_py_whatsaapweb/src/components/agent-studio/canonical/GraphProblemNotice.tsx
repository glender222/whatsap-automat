import type { GraphProblem } from './agentGraphApi';

export default function GraphProblemNotice({ problem, retry }: { problem: GraphProblem; retry?: () => void }) {
  return (
    <div role="alert" className="rounded-lg border border-red-200 p-4 text-sm text-red-800 dark:border-red-800 dark:text-red-200">
      <p>{problem.message}</p>
      {problem.fields.length > 0 && (
        <ul className="mt-2 list-disc space-y-1 pl-5">
          {problem.fields.map(({ name, reason }, index) => (
            <li key={`${name}-${index}`} className="break-words"><code>{name}</code> · {reason}</li>
          ))}
        </ul>
      )}
      {retry && <button type="button" onClick={retry} className="mt-1 min-h-11 font-semibold underline">Volver a intentar</button>}
    </div>
  );
}
