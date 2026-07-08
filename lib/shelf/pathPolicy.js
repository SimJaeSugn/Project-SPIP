'use strict';
/**
 * lib/shelf/pathPolicy.js — 하위호환 재수출 shim.
 *
 * 구현은 lib/common/pathPolicy.js 로 승격됐다(탐색기 위젯 browsePolicy가 동일 deny 게이트를
 * 재사용 — 도메인 교차 참조 회피). 기존 require 경로(셸프 핸들러·테스트)를 깨지 않도록 유지한다.
 */

module.exports = require('../common/pathPolicy');
