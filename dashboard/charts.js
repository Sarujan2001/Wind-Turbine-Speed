const COLORS = {
  wind: "#0879b9",
  windFill: "rgba(8, 121, 185, .09)",
  gust: "#e08b35",
  text: "#647482",
  grid: "#dfe6eb",
  tooltip: "#17232e"
};

function chartOptions() {
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: { duration: 280 },
    interaction: { mode: "index", intersect: false },
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: COLORS.tooltip,
        padding: 11,
        displayColors: true,
        callbacks: {
          title(items) { return items[0]?.label || ""; },
          label(context) {
            const name = context.dataset.label;
            return `${name}: ${Number(context.raw).toFixed(2)} m/s`;
          }
        }
      }
    },
    scales: {
      x: {
        ticks: { color: COLORS.text, maxTicksLimit: 8, maxRotation: 0, font: { size: 10 } },
        grid: { display: false },
        border: { color: COLORS.grid }
      },
      y: {
        beginAtZero: true,
        title: { display: true, text: "Wind Speed (m/s)", color: COLORS.text, font: { size: 10, weight: "600" } },
        ticks: { color: COLORS.text, font: { size: 10 } },
        grid: { color: COLORS.grid },
        border: { display: false }
      }
    }
  };
}

function datasets() {
  return [
    {
      label: "Wind",
      data: [],
      borderColor: COLORS.wind,
      backgroundColor: COLORS.windFill,
      borderWidth: 2.25,
      tension: .28,
      fill: true,
      pointRadius: 0,
      pointHoverRadius: 4,
      pointHoverBackgroundColor: COLORS.wind
    },
    {
      label: "Gust",
      data: [],
      borderColor: COLORS.gust,
      backgroundColor: "transparent",
      borderWidth: 1.5,
      borderDash: [5, 4],
      tension: .22,
      fill: false,
      pointRadius: 0,
      pointHoverRadius: 3,
      pointHoverBackgroundColor: COLORS.gust
    }
  ];
}

function create(canvas) {
  return new window.Chart(canvas, {
    type: "line",
    data: { labels: [], datasets: datasets() },
    options: chartOptions()
  });
}

function setData(chart, points) {
  chart.data.labels = points.map((point) => point.time.toLocaleTimeString([], {
    hour: "2-digit", minute: "2-digit", second: points.length < 80 ? "2-digit" : undefined
  }));
  chart.data.datasets[0].data = points.map((point) => point.ms);
  chart.data.datasets[1].data = points.map((point) => point.gustMs);
  chart.update("none");
}

function durationFor(range) {
  return { live: 5 * 60e3, "15m": 15 * 60e3, "1h": 60 * 60e3 }[range] || 5 * 60e3;
}

export function createCharts(mainCanvas, historyCanvas) {
  if (!window.Chart) throw new Error("Chart.js did not load");
  const main = create(mainCanvas);
  const history = create(historyCanvas);
  let selectedRange = "live";

  return {
    setRange(range, points) {
      selectedRange = range;
      this.updateMain(points);
    },
    updateMain(points) {
      const newest = points.at(-1)?.time.getTime() || Date.now();
      const cutoff = newest - durationFor(selectedRange);
      setData(main, points.filter((point) => point.time.getTime() >= cutoff));
    },
    updateHistory(points) { setData(history, points); },
    resizeHistory() { history.resize(); }
  };
}
