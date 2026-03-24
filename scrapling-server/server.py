"""
Scrapling HTTP Wrapper Server

Thin FastAPI wrapper around Scrapling's fetchers for the @ohwow/workspace.
Exposes simple REST endpoints instead of raw MCP JSON-RPC.
"""

import asyncio
import logging
from typing import Optional

from fastapi import FastAPI
from pydantic import BaseModel

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("scrapling-server")

app = FastAPI(title="Scrapling Server", version="1.0.0")


# ---------------------------------------------------------------------------
# Request / Response models
# ---------------------------------------------------------------------------

class FetchRequest(BaseModel):
    url: str
    selector: Optional[str] = None
    timeout: Optional[int] = 30
    proxy: Optional[str] = None
    headless: Optional[bool] = True


class BulkFetchRequest(BaseModel):
    urls: list[str]
    selector: Optional[str] = None
    timeout: Optional[int] = 30
    proxy: Optional[str] = None
    headless: Optional[bool] = True


class FetchResponse(BaseModel):
    url: str
    status: int
    html: str
    selected: Optional[list[str]] = None
    title: Optional[str] = None
    error: Optional[str] = None


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def extract_with_selector(response, selector: Optional[str]) -> Optional[list[str]]:
    """Extract elements using CSS selector if provided."""
    if not selector:
        return None
    try:
        elements = response.css(selector)
        return [el.text.strip() for el in elements if el.text.strip()]
    except Exception as e:
        logger.warning(f"CSS selector failed: {e}")
        return None


def get_title(response) -> Optional[str]:
    """Extract page title from response."""
    try:
        title_els = response.css("title")
        if title_els:
            return title_els[0].text.strip()
    except Exception:
        pass
    return None


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@app.get("/health")
async def health():
    return {"status": "ok", "service": "scrapling"}


@app.post("/fetch", response_model=FetchResponse)
async def fetch(request: FetchRequest):
    """Fast HTTP fetch with TLS fingerprint impersonation (no browser)."""
    from scrapling.fetchers import Fetcher

    try:
        fetcher = Fetcher(auto_match=True)
        response = await asyncio.to_thread(
            fetcher.get,
            request.url,
            timeout=request.timeout,
        )
        return FetchResponse(
            url=request.url,
            status=response.status,
            html=response.html_content,
            selected=extract_with_selector(response, request.selector),
            title=get_title(response),
        )
    except Exception as e:
        logger.error(f"Fetch failed for {request.url}: {e}")
        return FetchResponse(
            url=request.url, status=0, html="", error=str(e)
        )


@app.post("/stealth-fetch", response_model=FetchResponse)
async def stealth_fetch(request: FetchRequest):
    """Stealthy fetch using Camoufox browser (bypasses Cloudflare)."""
    from scrapling.fetchers import StealthyFetcher

    try:
        fetcher = StealthyFetcher(
            auto_match=True,
            headless=request.headless if request.headless is not None else True,
        )
        response = await asyncio.to_thread(
            fetcher.fetch,
            request.url,
            timeout=request.timeout,
        )
        return FetchResponse(
            url=request.url,
            status=response.status,
            html=response.html_content,
            selected=extract_with_selector(response, request.selector),
            title=get_title(response),
        )
    except Exception as e:
        logger.error(f"Stealth fetch failed for {request.url}: {e}")
        return FetchResponse(
            url=request.url, status=0, html="", error=str(e)
        )


@app.post("/dynamic-fetch", response_model=FetchResponse)
async def dynamic_fetch(request: FetchRequest):
    """Dynamic fetch with full browser JS rendering (Playwright Chromium)."""
    from scrapling.fetchers import PlayWrightFetcher

    try:
        fetcher = PlayWrightFetcher(
            auto_match=True,
            headless=request.headless if request.headless is not None else True,
        )
        response = await asyncio.to_thread(
            fetcher.fetch,
            request.url,
            timeout=request.timeout,
        )
        return FetchResponse(
            url=request.url,
            status=response.status,
            html=response.html_content,
            selected=extract_with_selector(response, request.selector),
            title=get_title(response),
        )
    except Exception as e:
        logger.error(f"Dynamic fetch failed for {request.url}: {e}")
        return FetchResponse(
            url=request.url, status=0, html="", error=str(e)
        )


@app.post("/bulk-fetch", response_model=list[FetchResponse])
async def bulk_fetch(request: BulkFetchRequest):
    """Fetch multiple URLs concurrently with fast HTTP."""
    from scrapling.fetchers import Fetcher

    async def fetch_one(url: str) -> FetchResponse:
        try:
            fetcher = Fetcher(auto_match=True)
            response = await asyncio.to_thread(
                fetcher.get, url, timeout=request.timeout
            )
            return FetchResponse(
                url=url,
                status=response.status,
                html=response.html_content,
                selected=extract_with_selector(response, request.selector),
                title=get_title(response),
            )
        except Exception as e:
            return FetchResponse(url=url, status=0, html="", error=str(e))

    results = await asyncio.gather(*[fetch_one(u) for u in request.urls])
    return list(results)


@app.post("/bulk-stealth-fetch", response_model=list[FetchResponse])
async def bulk_stealth_fetch(request: BulkFetchRequest):
    """Fetch multiple URLs with stealth browser (sequential to avoid detection)."""
    from scrapling.fetchers import StealthyFetcher

    results = []
    for url in request.urls:
        try:
            fetcher = StealthyFetcher(
                auto_match=True,
                headless=request.headless if request.headless is not None else True,
            )
            response = await asyncio.to_thread(
                fetcher.fetch, url, timeout=request.timeout
            )
            results.append(FetchResponse(
                url=url,
                status=response.status,
                html=response.html_content,
                selected=extract_with_selector(response, request.selector),
                title=get_title(response),
            ))
        except Exception as e:
            results.append(FetchResponse(url=url, status=0, html="", error=str(e)))
    return results


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8100, log_level="info")
