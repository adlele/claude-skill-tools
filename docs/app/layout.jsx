import { Footer, Layout, Navbar } from 'nextra-theme-docs'
import { Head } from 'nextra/components'
import { getPageMap } from 'nextra/page-map'
import 'nextra-theme-docs/style.css'

export const metadata = {
  title: {
    default: 'claude-skill-tools',
    template: '%s | claude-skill-tools'
  },
  description:
    'A collection of AI development tools, primarily built with Claude Code CLI in mind.'
}

const navbar = (
  <Navbar
    logo={<b>claude-skill-tools</b>}
    projectLink="https://github.com/anthropics/claude-skill-tools"
  />
)

const footer = (
  <Footer>
    <p>ISC {new Date().getFullYear()} &copy; claude-skill-tools</p>
  </Footer>
)

export default async function RootLayout({ children }) {
  return (
    <html lang="en" dir="ltr" suppressHydrationWarning>
      <Head />
      <body>
        <Layout
          navbar={navbar}
          pageMap={await getPageMap()}
          docsRepositoryBase="https://github.com/anthropics/claude-skill-tools/tree/main/docs"
          footer={footer}
          sidebar={{ defaultMenuCollapseLevel: 1 }}
        >
          {children}
        </Layout>
      </body>
    </html>
  )
}
