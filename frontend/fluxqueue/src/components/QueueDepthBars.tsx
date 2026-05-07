interface Props {
  high: number;
  default_: number;
  low: number;
}

export default function QueueDepthBars({ high, default_, low }: Props) {
  const max = Math.max(high, default_, low, 1);
  const bars = [
    { label: "High Priority", value: high, color: "bg-red-500" },
    { label: "Default", value: default_, color: "bg-yellow-500" },
    { label: "Low Priority", value: low, color: "bg-green-500" },
  ];
  return (
    <div className="space-y-4">
      {bars.map((b) => (
        <div key={b.label}>
          <div className="flex justify-between text-sm text-gray-400 mb-1">
            <span>{b.label}</span>
            <span className="text-white font-bold">{b.value}</span>
          </div>
          <div className="w-full bg-gray-700 rounded-full h-4">
            <div
              className={`${b.color} h-4 rounded-full transition-all duration-500`}
              style={{ width: `${(b.value / max) * 100}%` }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}
