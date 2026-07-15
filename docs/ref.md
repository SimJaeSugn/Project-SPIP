# Role & Objective
너는 LangGraph 프레임워크와 Python을 완벽하게 다루는 수석 AI 아키텍트다.
나의 요구사항인 [Plan-and-Solve + ReAct + Reflection] 하이브리드 에이전트 아키텍처를 LangGraph(버전 0.1 이상 구조)를 사용하여 강건하고 확장 가능한 코드로 구현해라.

# Architecture Concept
이 시스템은 복잡한 도면 및 파트리스트 분석 작업을 해결하기 위해 다음 3가지 패턴을 결합한다.
1. Planner (Plan-and-Solve): 거대한 사용자 요청을 해결하기 위한 하위 작업(Sub-tasks) 계획 목록을 생성 및 수정한다.
2. Executor (ReAct): 생성된 하위 작업을 Tool들을 활용하여 [Thought -> Action -> Observation] 루프로 유연하게 실행한다.
3. Reflector (Reflection): 실행 결과를 검증하고, 오류나 환각(Hallucination)이 발견되면 피드백과 함께 Planner로 되돌려 재계획(Replanning)을 강제한다.

# Technical Requirements & Implementation Details

1. State 정의 (LangGraph State)
- 전체 그래프가 공유할 `AgentState`를 정의해라. (TypedDict 활용)
- 필수 필드: 
  - `messages`: 대화 기록 (Annotated[Sequence[BaseMessage], add_messages])
  - `plan`: Planner가 생성한 현재 남은 하위 작업 리스트 (List[str])
  - `past_steps`: Executor가 완료한 작업과 결과 기록 (List[Tuple[str, str]])
  - `critique`: Reflector가 생성한 피드백 또는 검증 실패 사유 (str)
  - `is_valid`: 검증 통과 여부 (bool)

2. Nodes (노드 정의)
- `plan_node`: `messages`와 `critique`를 기반으로 할 일 목록(`plan`)을 최초 생성하거나 수정(Replanning)하는 노드.
- `execute_node`: `plan`에서 첫 번째 작업을 꺼내 `create_react_agent` 메커니즘을 모방하거나 내장 함수를 호출하여 해결하고 결과를 `past_steps`에 누적하는 노드.
- `reflect_node`: 최종 취합된 결과(`past_steps`)를 분석하여 비즈니스 규칙(예: 데이터 포맷, 컨텍스트 정합성) 및 환각 여부를 검증하고 `is_valid`와 `critique`를 갱신하는 노드.

3. Edges & Flow (흐름 정의)
- START -> `plan_node` -> `execute_node` -> `reflect_node`
- `reflect_node` 이후 **조건부 엣지(Conditional Edge)**를 구현해라:
  - 만약 `is_valid == True` 이면 -> END (최종 답변 출력)
  - 만약 `is_valid == False` 이면 -> `plan_node`로 리다이렉트 (피드백을 반영한 재계획 루프 진입)

4. Code Quality
- 코드 내에 더미(Dummy) 함수나 단순 텍스트가 아닌, LangGraph 오케스트레이션이 실제로 돌아가는 완전한(Production-ready) Python 코드를 작성해라.
- 외부 Tool을 가상으로 호출할 수 있는 모크 함수(예: `def search_drawing_db(query: str)`) 예시를 포함해라.
