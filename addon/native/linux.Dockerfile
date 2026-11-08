# SPDX-License-Identifier: AGPL-3.0-or-later
# The build uses the default 22.04 image; CI selects a pinned 24.04 base for
# the second runtime check.  Both image IDs are recorded in the Actions log.
ARG BASE_IMAGE=ubuntu:22.04@sha256:076e7bf82319619f28dd0aa9c02ab34b055ad37100395b4f49a2ffba04fb5e11
FROM ${BASE_IMAGE}
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
    && apt-get install --yes --no-install-recommends \
       binutils build-essential ca-certificates curl libatomic1 python3 \
    && rm -rf /var/lib/apt/lists/*
