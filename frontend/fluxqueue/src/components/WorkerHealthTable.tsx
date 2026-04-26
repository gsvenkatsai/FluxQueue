// src/components/WorkerHealthTable.tsx
interface Worker {
  hostname: string;
  is_online: boolean;
  active_jobs: number;
}

export default function WorkerHealthTable({ workers }: { workers: Worker[] }) {
  return (
    <table>
      <thead>
        <tr>
          <th>Worker</th>
          <th>Status</th>
          <th>Active Jobs</th>
        </tr>
      </thead>
      <tbody>
        {workers?.map((w) => (
          <tr key={w.hostname}>
            <td>{w.hostname}</td>
            <td>{w.is_online ? "🟢 Online" : "🔴 Offline"}</td>
            <td>{w.active_jobs}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
