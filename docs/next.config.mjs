import nextra from 'nextra'

const withNextra = nextra({
  contentDirBasePath: '/'
})

export default withNextra({
  output: 'export',
  images: { unoptimized: true },
  basePath: process.env.PAGES_BASE_PATH || ''
})
