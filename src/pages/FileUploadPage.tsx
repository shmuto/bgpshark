import { useEffect } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { useApp } from '../context/AppContext'
import { useI18n } from '../i18n'
import { FileDropzone } from '../components'

export function FileUploadPage() {
  const { status, loadFile, error, reset, progress } = useApp()
  const { t } = useI18n()
  const navigate = useNavigate()
  const location = useLocation()

  // Where the user was headed before being sent here for a capture, if anywhere.
  const from = (location.state as { from?: string } | null)?.from

  // Take the user to the screen they asked for once the capture is ready,
  // falling back to Messages when they came here directly: the workspace's
  // findings list is beside it, so there is no overview to stop at first.
  // `fresh` keeps a view saved from a previous capture from being restored.
  useEffect(() => {
    if (status === 'ready') {
      navigate(from ?? '/messages', { replace: true, state: from ? undefined : { fresh: true } })
    }
  }, [status, from, navigate])

  return (
    <div className="flex-1 flex flex-col items-center justify-center p-8 bg-canvas">
      {status === 'error' ? (
        <div className="text-center">
          <div className="w-16 h-16 mx-auto mb-4 bg-critical-subtle rounded-full flex items-center justify-center">
            <svg className="w-8 h-8 text-critical" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </div>
          <div className="text-critical text-lg font-medium mb-2">{t.common.error}</div>
          <div className="text-muted mb-4 max-w-md">{error}</div>
          <button
            onClick={reset}
            className="px-4 py-2 bg-accent text-accent-fg rounded hover:bg-accent-hover"
          >
            {t.common.tryAgain}
          </button>
        </div>
      ) : (
        <>
          <FileDropzone
            onFileLoad={loadFile}
            isLoading={status === 'loading' || status === 'initializing'}
            progress={progress}
          />

          {/* Not everyone arrives with a capture. Reproducing a session failure
              normally means a lab; the builder writes the file instead. */}
          <p className="mt-6 text-sm text-muted">
            {t.upload.noCapturePrefix}{' '}
            <Link to="/builder" className="text-accent underline-offset-2 hover:underline">
              {t.upload.buildOne}
            </Link>{' '}
            {t.upload.noCaptureSuffix}
          </p>

          {/* Features section */}
          <div className="mt-12 max-w-2xl w-full">
            <div className="border-t border-hair pt-8">
              <h2 className="text-sm font-semibold text-dim uppercase tracking-wide mb-4">
                {t.upload.featuresHeading}
              </h2>
              <ul className="grid gap-3 text-sm text-muted">
                <FeatureItem>{t.upload.feature1}</FeatureItem>
                <FeatureItem>{t.upload.feature2}</FeatureItem>
                <FeatureItem>{t.upload.feature3}</FeatureItem>
                <FeatureItem>{t.upload.feature4}</FeatureItem>
              </ul>

              {/* The one place every visitor passes through, which makes it the
                  place attribution belongs. Nothing here is fetched from a CDN,
                  so the fonts and libraries are redistributed by this app and
                  their notices travel with it. */}
              <p className="mt-8 text-xs text-dim">
                {t.upload.ossPrefix}{' '}
                <a
                  href={`${import.meta.env.BASE_URL}THIRD-PARTY-LICENSES.txt`}
                  className="underline underline-offset-2 hover:text-muted"
                >
                  {t.upload.ossLink}
                </a>
                .
              </p>
            </div>
          </div>
        </>
      )}
    </div>
  )
}

function FeatureItem({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2">
      <svg className="w-5 h-5 text-ok shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
      </svg>
      <span>{children}</span>
    </li>
  )
}
