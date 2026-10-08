/** @type {import('next').NextConfig} */
// R8 (Task 3): next-intl plugin wires ./src/i18n/request.ts so that
// getLocale()/getMessages() resolve the [locale] param at runtime.
// Without this, /ar renders English/LTR.
const createNextIntlPlugin = require("next-intl/plugin");
const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");
const nextConfig = {
  experimental: {
    serverActions: {
      allowedOrigins: ["localhost:3000"],
    },
  },
  typescript: {
    ignoreBuildErrors: false,
  },
  eslint: {
    ignoreDuringBuilds: false,
  },
};

module.exports = withNextIntl(nextConfig);
