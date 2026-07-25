FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    binutils \
    ca-certificates \
    coreutils \
    curl \
    elfutils \
    file \
    findutils \
    inotify-tools \
    iproute2 \
    ltrace \
    netbase \
    procps \
    python3 \
    strace \
    tcpdump \
    util-linux \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /analysis

COPY analyze.sh /usr/local/bin/analyze-sample
RUN chmod 0755 /usr/local/bin/analyze-sample

ENTRYPOINT ["/usr/local/bin/analyze-sample"]
