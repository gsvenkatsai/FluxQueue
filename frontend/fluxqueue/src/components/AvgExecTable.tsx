// src/components/AvgExecTable.tsx
export default function AvgExecTable({ data }: { data: Record<string, number> }) {
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="text-gray-400 text-xs uppercase tracking-wider border-b border-gray-700">
          <th className="pb-2 text-left font-semibold">Job Type</th>
          <th className="pb-2 text-right font-semibold">Avg (ms)</th>
        </tr>
      </thead>
      <tbody>
        {Object.entries(data ?? {}).map(([type, ms]) => (
          <tr key={type} className="border-b border-gray-700/50">
            <td className="py-2 text-gray-300 font-mono text-xs">{type}</td>
            <td className="py-2 text-right text-white font-bold">{ms.toLocaleString()}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
