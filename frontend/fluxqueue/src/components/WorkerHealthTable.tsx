// src/components/WorkerHealthTable.tsx
interface Worker {
  hostname: string;
  is_online: boolean;
  active_jobs: number;
}

export default function WorkerHealthTable({ workers }: { workers: Worker[] }) {
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="text-gray-400 text-xs uppercase tracking-wider border-b border-gray-700">
          <th className="pb-2 text-left font-semibold">Worker</th>
          <th className="pb-2 text-left font-semibold">Status</th>
          <th className="pb-2 text-left font-semibold">Active</th>
        </tr>
      </thead>
      <tbody>
        {workers?.map((w) => (
          <tr key={w.hostname} className="border-b border-gray-700/50">
            <td className="py-2 text-gray-300 font-mono text-xs truncate max-w-[120px]">{w.hostname}</td>
            <td className="py-2">
              {w.is_online ? (
                <span className="flex items-center gap-1 text-green-400 text-xs">
                  <span className="w-2 h-2 rounded-full bg-green-400 inline-block" />
                  Online
                </span>
              ) : (
                <span className="flex items-center gap-1 text-red-400 text-xs">
                  <span className="w-2 h-2 rounded-full bg-red-400 inline-block" />
                  Offline
                </span>
              )}
            </td>
            <td className="py-2 text-white font-bold">{w.active_jobs}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
