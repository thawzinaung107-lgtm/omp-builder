export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        omp: {
          brand: "#7158ef",
          brandHover: "#6350e0",
          brandSubtle: "#eeeafe",
          border: "#e8eaf2",
          success: "#1a956f",
          canvas: "#f7f8fc",
          surface: "#ffffff",
          nav: "#141827",
          ink: "#192136",
          muted: "#737c93",
        },
      },
      fontFamily: {
        sans: ['"DM Sans"', "Inter", "ui-sans-serif", "system-ui", "sans-serif"],
      },
      borderRadius: {
        omp: "12px",
        "omp-lg": "16px",
      },
    },
  },
  plugins: [],
};
