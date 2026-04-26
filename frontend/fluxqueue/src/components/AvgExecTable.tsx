// src/components/AvgExecTable.tsx
export default function AvgExecTable({
  data,
}: {
  data: Record<string, number>;
}) {
  return (
    <table>
      <thead>
        <tr>
          <th>Job Type</th>
          <th>Avg Time (ms)</th>
        </tr>
      </thead>
      <tbody>
        {Object.entries(data ?? {}).map(([type, ms]) => (
          <tr key={type}>
            <td>{type}</td>
            <td>{ms}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
